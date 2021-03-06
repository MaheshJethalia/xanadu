import { expect } from 'chai';
import * as _ from 'lodash';
import Game from './game';
import { TEST_PARSE_RESULT } from '../game/map/parseGrid';
import { Position } from '../game/map/cell';
import { Action } from '../game/actions';
import { GamePlayer, Player, createPlayer, getPlayerState, LobbyPlayer } from '../game/player';
import * as Messaging from '../game/messaging';
import * as Character from '../game/character';
import Lobby from './lobby';
import * as Sinon from 'sinon';

const createGame = (players: Player[] = []): Game => {
  return new Game(8, players);
};

describe('Game', () => {
  describe('constructor', () => {
    it('should set default arguments', () => {
      const g = createGame();
      expect(g.players).to.eql([]);
      expect(g.map.grid).to.eql(TEST_PARSE_RESULT.grid);
      expect(g.maxPlayers).to.equal(8);
      expect(g.turnNumber).to.equal(0);
      expect(g.hasEnded).to.equal(false);
    });
  });

  describe('handleMessage', function () {
    let game: Game;
    let player1: GamePlayer;
    let player2: GamePlayer;
    let player3: GamePlayer;
    let responses: Messaging.Message[];
    before(function () {
      game = createGame([
        createPlayer('vader', 'Darth_Vader'),
        createPlayer('yoda', 'Yoda'),
        createPlayer('r2d2', 'R2D2')
      ]);

      player1 = game.getPlayer('vader') !;
      player2 = game.getPlayer('yoda') !;
      player3 = game.getPlayer('r2d2') !;

      // now, force all the players to the same allegiance so they can communicate freely
      [ player1, player2, player3 ].forEach((player: GamePlayer) => {
        player.character.allegiance = 'Eastern';
      });
    });
    describe('when given a valid action command', function () {
      before(function () {
        expect(player1.character.nextAction).to.be.null;
        responses = game.handleMessage({
          content: 'go south', // a valid movement on the default test map
          player: player1,
          timestamp: Date.now()
        });
      });
      after(function () {
        game.handleMessage({
          content: 'go north', // after the tests, reverse the movement
          player: player1,
          timestamp: Date.now()
        });
      });
      it('should update the sender\'s character\'s `nextAction` field', function () {
        expect(player1.character.nextAction).to.not.be.null;
      });
      it('should send a response to the player confirming their next action', function () {
        const hasConfirmation =
          _.some(responses as Messaging.Message[],
            (message) => _.startsWith(message.content, 'Next action:'));

        expect(hasConfirmation).to.be.true;
      });
    });
    describe('when given an invalid action command', function () {
      before(function () {
        player1.character.nextAction = null;
        responses = game.handleMessage({
          content: 'go north', // north of the starting position is a barrier,
          player: player1,
          timestamp: Date.now()
        });
      });
      it('should not update the `nextAction` field', function () {
        expect(player1.character.nextAction).to.be.null;
      });
      it('should send a rejection to the player', function () {
        const hasRejection =
          _.some(responses as Messaging.Message[],
            (message) => _.startsWith(message.content, 'Invalid action:'));

        expect(hasRejection).to.be.true;
      });
    });
    describe('when given a communication command', function () {
      describe('for talking', function () {
        before(function () {
          responses = game.handleMessage({
            content: '/t yod May the force be with you',
            player: player1,
            timestamp: Date.now()
          });
        });
        it('should have sent a talk message to the other player', function () {
          const result =
            _.some(responses as Messaging.Message[],
              (message) => message.type === 'Talk' && _.startsWith(message.content, 'May the force'));

          expect(result).to.be.true;
        });
      });
      describe('for shouting', function () {
        before(function () {
          responses = game.handleMessage({
            content: '/s HELP!',
            player: player1,
            timestamp: Date.now()
          });
        });
        it('should have sent a shout message to the other players', function () {
          const shout = _.find(responses as Messaging.Message[],
            (message) => message.type === 'Shout') !;

          expect(shout).to.be.ok;
          expect(shout.content).to.equal('HELP!');
          expect(shout.to.length).to.equal(2);
          expect(shout.to.map(player => player.id))
            .to.include(player2.id).and
            .to.include(player3.id).and
            .to.not.include(player1.id);
        });
      });
      describe('for whispering', function () {
        before(function () {
          responses = game.handleMessage({
            content: '/w r2 darth is a sith', // I know that's not how Yoda speaks...
            player: player2,
            timestamp: Date.now()
          });
        });
        it('should have sent a whisper message ot the other player', function () {
          const whisper = _.find(responses as Messaging.Message[],
            message => message.type === 'Whisper') !;

          expect(whisper).to.be.ok;
          expect(whisper.to[ 0 ].id).to.eql(player3.id);
          expect(whisper.content).to.eql('darth is a sith');
        });
      });
      describe('for unknown communications', function () {
        before(function () {
          responses = game.handleMessage({
            content: '/-blarg-',
            player: player3,
            timestamp: Date.now()
          });
        });
        it('should have sent a rejection message', function () {
          const result = _.some(responses as Messaging.Message[],
            (message) => message.type === 'Game' && _.startsWith(message.content, 'Unknown communication:'));

          expect(result).to.be.true;
        });
      });
    });
    describe('when given an unknown command', function () {
      before(function () {
        responses = game.handleMessage({
          content: 'foobarbaz',
          player: player1,
          timestamp: Date.now()
        });
      });
      it('should have a rejection message', function () {
        const hasRejection =
          _.some(responses as Messaging.Message[],
            (message) => _.startsWith(message.content, 'Unknown command or communication'));

        expect(hasRejection).to.be.true;
      });
    });
  });

  describe('isAcceptingPlayers', () => {
    it('should always return `false`', () => {
      expect(createGame().isAcceptingPlayers()).to.be.false;
    });
  });

  describe('isRunning', () => {
    // `hasEnded = false` upon game creation
    it('should be true if the game has not ended', () => {
      expect(createGame().isRunning()).to.be.true;
    });

    it('should be false if the game has started and ended', () => {
      const game = createGame();
      game.hasEnded = true;
      expect(game.isRunning()).to.equal(false);
    });
  });

  describe('isReadyForNextContext', () => {
    let game: Game;
    beforeEach(function () {
      const players: Player[] = [
        { id: 'foo', name: 'Foo' },
        { id: 'bar', name: 'Baz' },
        { id: 'baz', name: 'Baz' }
      ];

      game = new Game(8, players);
    });
    it('should return true when the game has ended', function () {
      expect(game.isReadyForNextContext()).to.be.false;

      const gamePlayers = [ 'foo', 'bar', 'baz' ].map(playerId => {
        const somePlayer = game.getPlayer(playerId);

        if (!somePlayer) {
          throw new Error('Missing player for testing!');
        }

        return somePlayer;
      });

      // kill the first two, the last one escapes
      gamePlayers[ 0 ].character.stats.health = 0;
      gamePlayers[ 1 ].character.stats.health = 0;

      expect(game.isReadyForNextContext()).to.be.false;

      gamePlayers[ 2 ].character.hasEscaped = true;

      expect(game.isReadyForNextContext()).to.be.true;
    });
  });

  describe('update', () => {
    let game: Game;
    let p1: GamePlayer;
    let p2: GamePlayer;
    before(function () {
      game = createGame([
        createPlayer('123', 'Alice'),
        createPlayer('456', 'Bob')
      ]);

      p1 = game.getPlayerByName('Alice') !;
      p2 = game.getPlayerByName('Bob') !;
    });

    it('should work with move actions', function () {
      // a valid movement
      const r1: Messaging.Message[] = game.handleMessage({
        player: p1,
        content: 'go south',
        timestamp: Date.now()
      });

      // don't really care about the result of p2's command
      game.handleMessage({
        player: p2,
        content: 'pass',
        timestamp: Date.now()
      });

      const hasNextActionMessage = _
        .chain(r1 as Messaging.Message[])
        .map('content')
        .some(content => _.includes(content, 'Next action'))
        .value();

      expect(hasNextActionMessage).to.be.true;

      expect(p1.character.nextAction).to.be.ok;

      expect(p1.character.nextAction!.key).to.equal('Move');
      expect(p2.character.nextAction!.key).to.equal('Pass');

      game.update();

      expect(p1.character.row).to.equal(2);
      expect(p1.character.col).to.equal(1);
    });

    context('when one of the players is killed during the update', function () {
      let origAlicePos: Position;
      let origBobPos: Position;
      let origBobHealth: number;
      let getSortedActionsStub: Sinon.SinonStub;
      before(function () {
        // first, save some previous data
        origAlicePos = {
          row: p1.character.row,
          col: p1.character.col
        };

        origBobHealth = p2.character.stats.health;

        origBobPos = {
          row: p2.character.row,
          col: p2.character.col
        };

        p2.character.stats.health = 1;

        // put Alice and Bob in the same room
        const pos = game.startingRoom;

        p1.character.row = pos.row;
        p1.character.col = pos.col;
        p2.character.row = pos.row;
        p2.character.col = pos.col;

        // now set up the proper actions
        game.handleMessage({
          content: 'attack bob fist 1',
          player: p1,
          timestamp: Date.now()
        });

        game.handleMessage({
          content: 'pass',
          player: p2,
          timestamp: Date.now()
        });

        expect(game.isReadyForUpdate()).to.be.true;

        // force the moves to be returned regardless of true sorting order
        getSortedActionsStub = Sinon.stub(game, 'getSortedActions').callsFake(() => {
          return [ p1.character.nextAction, p2.character.nextAction ];
        });
      });
      after(function () {
        getSortedActionsStub.restore();
        p2.character.stats.health = origBobHealth;
        _.extend(p1.character, origAlicePos);
        _.extend(p2.character, origBobPos);
      });
      it('should deliver the proper messages', function () {

        const results = game.update();

        expect(p2.character.stats.health).to.eql(0);

        const deathLogMessage = _.find(results.log, logMsg => logMsg.indexOf('Animal died') > -1);

        expect(deathLogMessage).to.exist;

        const deathNoticeMessage = _.find(results.messages, msg => {
          const toPlayer = msg.to[ 0 ];

          return toPlayer.id === p2.id && msg.content.indexOf('died before') > -1;
        });

        expect(deathNoticeMessage).to.exist;
      });
    });
  });

  describe('isReadyForUpdate', () => {
    it('should be true iff all players have an action', () => {
      const game = createGame([
        createPlayer('007', 'James_Bond'),
        createPlayer('008', 'Bill')
      ]);

      const p1 = game.getPlayer('007');
      const p2 = game.getPlayer('008');

      if (!p1 || !p2) {
        throw new Error('Test players not present!');
      }

      p1.character.nextAction = {
        timestamp: Date.now(),
        actor: p1.character,
        key: 'Pass'
      };

      p2.character.nextAction = null;

      expect(game.isReadyForUpdate()).to.be.false;

      p2.character.nextAction = {
        timestamp: Date.now(),
        actor: p2.character,
        key: 'Pass'
      };

      expect(game.isReadyForUpdate()).to.be.true;
    });
  });

  describe('getNearbyAnimals', function () {
    let game: Game;
    let player1: GamePlayer;
    let player2: GamePlayer;
    before(function () {
      game = createGame([
        createPlayer('luke', 'Luke'),
        createPlayer('leia', 'Leia')
      ]);

      player1 = game.getPlayer('luke') !;
      player2 = game.getPlayer('leia') !;
    });

    it('should return the other player', function () {
      const nearby = game.getNearbyAnimals(player1.character);

      expect(nearby).to.include(player1.character).and.to.include(player2.character);
    });
  });

  describe('getSortedActions', function () {
    let game: Game;
    let player1: GamePlayer;
    let player2: GamePlayer;
    let player3: GamePlayer;
    let sortedActions: Action[];
    before(function () {
      game = createGame([
        createPlayer('123', 'Alice'),
        createPlayer('456', 'Bob'),
        createPlayer('789', 'Carol')
      ]);

      player1 = game.getPlayer('123') !;
      player2 = game.getPlayer('456') !;
      player3 = game.getPlayer('789') !;

      player1.character.stats = {
        health: 50,
        intelligence: 50,
        strength: 50,
        agility: 50
      };

      player2.character.stats.agility = 1;
      player3.character.stats.agility = 1;

      expect(game.getPlayer('123') !.character.stats.agility)
        .to.be.greaterThan(game.getPlayer('456') !.character.stats.agility).and
        .to.be.greaterThan(game.getPlayer('789') !.character.stats.agility);

      game.handleMessage({
        content: 'go south',
        player: player2,
        timestamp: 1
      });

      game.handleMessage({
        content: 'go south',
        player: player3,
        timestamp: 0
      });

      game.handleMessage({
        content: 'go south',
        player: player1,
        timestamp: 2
      });

      // the order should be [p1, p3, p2]
      // p1 has highest agility
      // p3's timestamp is before p2's timestamp
      sortedActions = game.getSortedActions();
    });
    it('should sort first by player agility', function () {
      const firstActor = sortedActions[ 0 ].actor as Character.Character;
      expect(firstActor.playerId).to.eql(player1.id);
    });
    it('should sort second by timestamp', function () {
      const secondActor = sortedActions[ 1 ].actor as Character.Character;
      expect(secondActor.playerId).to.equal(player3.id);
      const thirdActor = sortedActions[ 2 ].actor as Character.Character;
      expect(thirdActor.playerId).to.equal(player2.id);
    });
  });

  describe('convertPlayer', function () {
    let game: Game;
    before(function () {
      game = new Game(8, [ {
        id: '123', name: 'Alice'
      }], {
          numModifiers: {
            maximum: Character.MAX_NUM_MODIFIERS,
            minimum: 0
          },
          seed: Date.now()
        });
    });
    context('when given a GamePlayer', function () {
      it('should return the player', function () {
        const gamePlayer = game.getPlayer('123');

        if (!gamePlayer) {
          throw new Error('Test player not present!');
        }

        expect(game.convertPlayer(gamePlayer)).to.eql(gamePlayer);
      });
    });
    context('when given a LobbyPlayer', function () {
      let lobby: Lobby;
      let player: LobbyPlayer;
      before(function () {
        lobby = new Lobby(8, []);

        lobby.addPlayer('007', 'James_Bond');

        player = lobby.getPlayer('007') !;

        lobby.handleMessage({
          player,
          timestamp: Date.now(),
          content: 'ready c=gunslinger a=western m=3'
        });

        expect(player.primordialCharacter.className).to.equal('Gunslinger');
      });
      it('should build off of the primordial character', function () {
        const gamePlayer = game.convertPlayer(player);

        expect(getPlayerState(gamePlayer)).to.equal('Playing');
        expect(gamePlayer.character.characterClass.className).to.equal('Gunslinger');
        expect(gamePlayer.character.allegiance).to.equal('Western');
        expect(Character.getActiveModifierNames(gamePlayer.character.modifiers)).to.have.lengthOf(3);
      });
    });
  });
});
