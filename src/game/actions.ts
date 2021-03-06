import * as Animal from './animal';
import * as Character from './character';
import * as Map from './map/map';
import * as Cell from './map/cell';
import Game from '../context/game';
import { moveEntity } from './entity';
import * as _ from 'lodash';
import * as Messaging from './messaging';
import describeRoom from './map/describeRoom';
import { reveal } from './map/characterMap';
import * as Inventory from './inventory';
import * as Ingestible from './items/ingestible';
import * as Stats from './stats';
import * as Weapon from './items/weapon';
import { isApproximateSubstring } from '../helpers';
import * as Item from './items/item';
import { isPlaying } from './player';
import { ItemName, itemNames, stringToItemName } from './items/itemName';

export interface Action {
  actor: Animal.Animal;
  timestamp: number;
  key: ComponentKey;
};

export type ValidationResult = {
  isValid: boolean,
  error?: string
};

export type ComponentKey = 'Move' | 'Pass' | 'Ingest' | 'Rest' | 'Attack'
  | 'Pickup' | 'Drop';

// TODO rename to PerformanceResult
export type PerformResult = {
  log: string[];
  messages: Messaging.Message[];
};

export interface ActionParserComponent<A extends Action> {
  pattern: RegExp;
  parse: (text: string, actor: Animal.Animal, timestamp: number) => A;
  validate: (action: A, gameContext: Game) => ValidationResult;
  perform: (action: A, game: Game, log: string[]) => PerformResult;
  componentKey: ComponentKey;
}

export interface MoveAction extends Action {
  // offset prefix shows that these are relative movents (-1|0|1)
  offsetRow: number;
  offsetCol: number;
}

export interface IngestAction extends Action {
  itemName: Ingestible.Name;
}

export interface AttackAction extends Action {
  targetName: string;
  weaponName: Weapon.AttackWeaponName;
  times: number;
}

export interface ItemTransaction extends Action {
  itemName: ItemName;
  transactionAmount?: number;
}

// nothing special about pass or rest actions
export interface PassAction extends Action { };
export interface RestAction extends Action { };

export function isActionTypeOf<A extends Action>(action: Action, component: ActionParserComponent<A>): action is A {
  return action.key === component.componentKey;
}

export const MOVE_COMPONENT: ActionParserComponent<MoveAction> = {
  pattern: /^go (north|south|east|west)$/i,
  parse(text: string, actor: Animal.Animal, timestamp: number) {
    const matches = text.match(this.pattern);

    if (!matches) {
      throw new Error(`Unable to parse MoveAction: ${text}`);
    } else {
      const dir = matches[ 1 ].toLowerCase();

      const ret: MoveAction = {
        actor,
        timestamp,
        offsetRow: 0,
        offsetCol: 0,
        key: 'Move'
      };

      if (dir === 'north') {
        ret.offsetRow = -1;
      } else if (dir === 'south') {
        ret.offsetRow = 1;
      } else if (dir === 'west') {
        ret.offsetCol = -1;
      } else if (dir === 'east') {
        ret.offsetCol = 1;
      } else {
        throw new Error(`Unknown direction: ${dir}`);
      }

      return ret;
    }
  },
  validate(move: MoveAction, game: Game): ValidationResult {
    const newR = move.actor.row + move.offsetRow;
    const newC = move.actor.col + move.offsetCol;
    const newPos = {
      row: newR,
      col: newC
    };

    if (!Map.isWithinMap(game.map, newPos)) {
      return {
        isValid: false,
        error: 'Out of bounds movement!'
      };
    } else if (!Cell.isRoom(Map.getCell(game.map, newPos))) {
      return {
        isValid: false,
        error: 'Desired location is not a room!'
      };
    } else {
      return { isValid: true };
    }
  },
  perform(move: MoveAction, game: Game, log: string[]): PerformResult {
    const oldPos = {
      row: move.actor.row,
      col: move.actor.col
    };

    const newPos = {
      row: oldPos.row + move.offsetRow,
      col: oldPos.col + move.offsetCol
    };

    moveEntity(move.actor, newPos);

    const messages: Messaging.Message[] = [];

    if (Character.isPlayerCharacter(move.actor)) {
      const player = game.getPlayer(move.actor.playerId);

      if (!player) {
        throw new Error(`Tried to move a non-present player! Id: ${move.actor.playerId}`);
      }

      log.push(`${player.name} from ${JSON.stringify(oldPos)} to ${JSON.stringify(newPos)}`);

      messages.push(Messaging.createGameMessage('You moved!', [ player ]));

      const newRoom = Map.getCell(game.map, newPos) as Cell.Room;

      messages.push(Messaging.createGameMessage(describeRoom(newRoom, game.map), [ player ]));

      if (Inventory.hasItem(player.character.inventory, 'Map')) {
        reveal(player.character.map, Map.getCell(game.map, newPos));
      }
    }

    return {
      log,
      messages
    };
  },
  componentKey: 'Move'
};

export const PASS_COMPONENT: ActionParserComponent<PassAction> = {
  pattern: /^pass$/i,
  parse(_text: string, actor: Animal.Animal, timestamp: number) {
    return {
      actor,
      timestamp,
      key: 'Pass'
    };
  },
  validate(passAction: PassAction, _game: Game) {
    return { isValid: Boolean(passAction) };
  },
  perform(passAction: Action, game: Game, log: string[]): PerformResult {
    // pass (do nothing!)

    const messages: Messaging.Message[] = [];

    if (Character.isPlayerCharacter(passAction.actor)) {
      const player = game.getPlayer(passAction.actor.playerId);

      if (player) {
        messages.push(Messaging.createGameMessage('You performed no action.', [ player ]));
      } else {
        throw new Error(`A non-present player tried to perform a pass action! Id: ${passAction.actor.playerId}`);
      }
    }

    return {
      log,
      messages
    };
  },
  componentKey: 'Pass'
};

export const REST_COMPONENT: ActionParserComponent<RestAction> = {
  pattern: /^rest$/i,
  parse(_text: string, actor: Animal.Animal, timestamp: number) {
    return {
      actor,
      timestamp,
      key: 'Rest'
    };
  },
  validate(restAction: RestAction, game: Game): ValidationResult {
    const actor = restAction.actor;
    if (Character.isPlayerCharacter(actor)) {
      const currCell = Map.getCell(game.map, actor);

      if (Cell.isRoom(currCell)) {
        if (currCell.hasCamp) {
          return { isValid: true };
        } else {
          return {
            isValid: false,
            error: 'Cannot rest without camp setup!'
          };
        }
      } else {
        throw new Error('Expected player to be in room!');
      }
    } else {
      return { isValid: true };
    }
  },
  perform(restAction: RestAction, game: Game, log: string[]): PerformResult {
    const messages: Messaging.Message[] = [];
    const actor = restAction.actor;

    if (Character.isPlayerCharacter(actor)) {
      const wasExhausted = Character.meterIsActive(actor.effects.exhaustion);
      actor.effects.exhaustion.current = actor.effects.exhaustion.maximum;

      const player = game.getPlayer(actor.playerId);

      if (!player) {
        throw new Error(`Tried to perform a RestAction with a non-present player! Id: ${actor.playerId}`);
      }

      if (wasExhausted) {
        messages.push(
          Messaging.createGameMessage('You rested at the camp and no longer feel exhausted.', [ player ])
        );
      } else {
        messages.push(
          Messaging.createGameMessage('You rested at the camp.', [ player ])
        );
      }
    }

    return {
      log,
      messages
    };
  },
  componentKey: 'Rest'
};

// This is the most generic of attack-related parser components
// TODO: shoot, strike, hit
export const ATTACK_COMPONENT: ActionParserComponent<AttackAction> = {
  pattern: new RegExp(`^attack (\\w+) (${Weapon.namesForAttacking.join('|')}) (\\d+)$`, 'i'),
  parse(text: string, actor: Animal.Animal, timestamp: number): AttackAction {
    const matches = text.match(this.pattern);

    if (!matches) {
      throw new Error(`Unable to parse AttackAction: ${text}`);
    } else {
      const targetName = matches[ 1 ];
      const weaponName = matches[ 2 ];
      const times = parseInt(matches[ 3 ], 10);
      const actualWeaponName = Weapon.stringToAttackWeaponName(weaponName);
      if (actualWeaponName) {
        return {
          actor,
          timestamp,
          targetName,
          weaponName: actualWeaponName,
          times,
          key: 'Attack'
        };
      } else {
        throw new Error(`Attempted to attack with a non-weapon: ${weaponName}`);
      }
    }
  },
  validate(attackAction: AttackAction, game: Game): ValidationResult {
    const inventory = attackAction.actor.inventory;

    if (attackAction.weaponName !== 'Fist' && !Inventory.hasItem(inventory, attackAction.weaponName)) {
      return {
        isValid: false,
        error: `Missing ${attackAction.weaponName} in inventory!`
      };
    } else if (!isFinite(attackAction.times) || attackAction.times <= 0) {
      return {
        isValid: false,
        error: `Bad number of times attacking (${attackAction.times})!`
      };
    } else {
      const actor = attackAction.actor;
      let weaponStack: Item.ItemStack<Weapon.AttackWeapon>;

      if (attackAction.weaponName === 'Fist') {
        weaponStack = Item.createItemStack(Weapon.FIST, 1, 1);
      } else {
        weaponStack = Inventory.getItem(inventory, attackAction.weaponName) as Item.ItemStack<Weapon.AttackWeapon>;
      }

      // now get the target

      // XXX: should we allow players to attack themselves?

      // first, look through our list of players
      const targetPlayer = _.find(game.players,
        player => isPlaying(player) && isApproximateSubstring(attackAction.targetName, player.name));

      if (!targetPlayer) {
        return {
          isValid: false,
          error: `No player with name '${attackAction.targetName}'!`
        };
      }

      // then check if the player is within attack range
      const actualDistance = Cell.cardinalPositionDistance(
        Map.getCell(game.map, actor), Map.getCell(game.map, targetPlayer.character)
      );

      if (actualDistance > weaponStack.item.range) {
        return {
          isValid: false,
          error: `${targetPlayer.name} is out of ${weaponStack.item.name}'s attack range!`
        };
      }

      // check that gun shot is in a straight line and unobstructed
      if (targetPlayer.character.row === actor.row || targetPlayer.character.col === actor.col) {
        const cellsInBetween = Cell.getPositionsBetween(
          targetPlayer.character, actor
        ).map(pos => Map.getCell(game.map, pos));

        if (_.some(cellsInBetween, cell => Cell.isBarrier(cell))) {
          return {
            isValid: false,
            error: `Your shot is obstructed by a barrier!`
          };
        } else {
          // ok
        }
      } else {
        return {
          isValid: false,
          error: `You can only shoot in straight lines!`
        };
      }

      // now check that if the player is attacking with a gun, that they have the bullets required
      if (Weapon.isWeaponGun(weaponStack.item)) {
        if (Inventory.hasItem(inventory, weaponStack.item.bullet)) {
          const bulletStack = Inventory.getItem(inventory, weaponStack.item.bullet) !;

          if (bulletStack.stackAmount < attackAction.times) {
            const t = attackAction.times;
            const b = bulletStack.stackAmount;
            return {
              isValid: false,
              error: `You cannot shoot ${t} time(s) because you only have ${b} bullet(s)!`
            };
          } else {
            // ok
          }
        } else {
          return {
            isValid: false,
            error: `You don't have ${weaponStack.item.bullet}s for your ${weaponStack.item.name}!`
          };
        }
      } else {
        // ok
      }
    }

    return {
      isValid: true
    };
  },
  perform(attackAction: AttackAction, game: Game, log: string[]): PerformResult {
    if (!Weapon.stringIsAttackWeaponName(attackAction.weaponName)) {
      throw new Error('Expected `weaponName` to be an attack weapon name!');
    }

    const result: PerformResult = {
      log, messages: []
    };

    let weaponStack: Item.ItemStack<Weapon.AttackWeapon>;

    if (attackAction.weaponName === 'Fist') {
      weaponStack = Item.createItemStack(Weapon.FIST, 1, 1);
    } else {
      weaponStack = Inventory.getItem(
        attackAction.actor.inventory, attackAction.weaponName
      ) as Item.ItemStack<Weapon.AttackWeapon>;
    }

    let accuracyPercentage: number;

    if (Weapon.isWeaponGun(weaponStack.item)) {
      accuracyPercentage = weaponStack.item.accuracy;
    } else {
      accuracyPercentage = 100;
    }

    // TODO: incorporate agility or some other stat
    const actualTimesAttacked = Math.floor(attackAction.times * accuracyPercentage / 100.0);

    const targetPlayer = _.find(game.players,
      player => isPlaying(player) && isApproximateSubstring(attackAction.targetName, player.name));

    if (!targetPlayer) {
      throw new Error(`Expected target player "${attackAction.targetName}" to exist!`);
    }

    // Do the damage to the target
    const totalDamage = actualTimesAttacked * weaponStack.item.damageAmount;

    targetPlayer.character.stats.health = Math.max(0, targetPlayer.character.stats.health - totalDamage);

    if (Character.isPlayerCharacter(attackAction.actor)) {
      const actorPlayer = game.getPlayer(attackAction.actor.playerId);

      if (!actorPlayer) {
        throw new Error('Expected AttackAction actor to exist!');
      }

      result.messages.push(
        Messaging.createGameMessage(
          `You attacked ${targetPlayer.name} ${actualTimesAttacked} time(s) for a total of ${totalDamage} damage!`,
          [ actorPlayer ]
        )
      );
    }

    let attackerName: string;

    if (Character.isPlayerCharacter(attackAction.actor)) {
      const actorPlayer = game.getPlayer(attackAction.actor.playerId);

      if (!actorPlayer) {
        throw new Error('Expected AttackAction actor to exist!');
      }

      attackerName = actorPlayer.name;
    } else {
      throw new Error('Expected attacker to be a player!');
    }

    result.messages.push(
      Messaging.createGameMessage(
        `${attackerName} attacked you for ${totalDamage} damage!`, [ targetPlayer ]
      )
    );

    if (Animal.isDead(targetPlayer.character)) {
      if (Character.isPlayerCharacter(attackAction.actor)) {
        const actorPlayer = game.getPlayer(attackAction.actor.playerId);

        if (!actorPlayer) {
          throw new Error('Expected AttackAction actor to exist!');
        }

        result.messages.push(
          Messaging.createGameMessage(
            `You killed ${targetPlayer.name}!`, [ actorPlayer ]
          )
        );
      }
      result.messages.push(
        Messaging.createGameMessage(
          `You were killed by ${attackerName}`, [ targetPlayer ]
        )
      );
    }

    // Now either make the attacker tired or take away their used bullets
    if (Weapon.isWeaponGun(weaponStack.item)) {
      const { inventory: newInventory } = Inventory.removeFromInventory(
        attackAction.actor.inventory, weaponStack.item.bullet, attackAction.times
      );

      attackAction.actor.inventory = newInventory;
    } else {
      attackAction.actor.stats.strength -= actualTimesAttacked;
      attackAction.actor.stats.agility -= attackAction.times;
    }

    return result;
  },
  componentKey: 'Attack'
};

export const INGEST_COMPONENT: ActionParserComponent<IngestAction> = {
  pattern: new RegExp(`^(eat|consume|ingest|use|drink|quaff) (${Ingestible.names.join('|')})$`, 'i'),
  parse(text: string, actor: Animal.Animal, timestamp: number): IngestAction {
    const matches = text.match(this.pattern);

    if (!matches) {
      throw new Error(`Could not parse IngestAction: ${text}`);
    } else {
      const ingestibleInput = matches[ 2 ].toLowerCase();
      const itemName = Ingestible.stringToIngestibleName(ingestibleInput);
      if (itemName) {
        return {
          actor,
          timestamp,
          itemName,
          key: 'Ingest'
        };
      } else {
        throw new Error(`Attempted to ingest a non-ingestible: ${ingestibleInput}`);
      }
    }
  },
  validate(ingestAction: IngestAction, _game: Game): ValidationResult {
    const inventory = ingestAction.actor.inventory;

    if (Inventory.hasItem(inventory, ingestAction.itemName)) {
      return {
        isValid: true
      };
    } else {
      return {
        isValid: false,
        error: `Missing ${ingestAction.itemName} in inventory!`
      };
    }
  },
  perform(ingestAction: IngestAction, game: Game, log: string[]): PerformResult {
    const messages: Messaging.Message[] = [];

    // first remove a single item from the item stack in the inventory
    const removalReturn = Inventory.removeFromInventory(
      ingestAction.actor.inventory, ingestAction.itemName, 1
    );

    ingestAction.actor.inventory = removalReturn.inventory;

    const itemStack = removalReturn.itemStack;

    const item = itemStack.item;

    if (Ingestible.itemIsIngestible(item)) {
      // then apply the item's stats to the actor
      Stats.changeStats(ingestAction.actor.stats, item.stats);

      const actor = ingestAction.actor;

      if (Character.isPlayerCharacter(actor)) {
        // then update any effects on the character
        const player = game.getPlayer(actor.playerId);

        if (!player) {
          throw new Error(`Tried to perform an IngestAction with a non-present player! Id: ${actor.playerId}`);
        }

        if (item.curesPoisoning && actor.effects.poison.isActive) {
          actor.effects.poison.isActive = false;

          messages.push(
            Messaging.createGameMessage('You have been cured of poisoning!', [ player ]
            ));

          log.push(`${player.name} poison removed`);
        }

        if (item.isPoisoned) {
          actor.effects.poison.isActive = true;

          messages.push(
            Messaging.createGameMessage('You have been poisoned!', [ player ])
          );

          log.push(`${player.name} was poisoned`);
        }

        if (item.isAddictive) {
          const characterBecomesAddicted = game.rng.pickone([ true, false ]);

          if (characterBecomesAddicted) {
            actor.effects.addiction.isActive = true;

            messages.push(
              Messaging.createGameMessage('You have become addicted!', [ player ])
            );

            log.push(`${player.name} became addicted`);
          }
        }

        if (item.givesImmortality) {
          actor.effects.immortality.isActive = true;
        }

        actor.effects.addiction.current = Character.updateMeterCurrentValue(
          actor.effects.addiction, item.addictionRelief
        );

        actor.effects.exhaustion.current = Character.updateMeterCurrentValue(
          actor.effects.exhaustion, item.exhaustionRelief
        );

        actor.effects.hunger.current = Character.updateMeterCurrentValue(
          actor.effects.hunger, item.hungerRelief
        );
      }
      return { log, messages };
    } else {
      throw new Error(`Tried to ingest an item that is not ingestible: '${item.name}'`);
    }
  },
  componentKey: 'Ingest'
};

// TODO: add ability to pick up a certain amount of an item (stack)
export const PICKUP_ACTION: ActionParserComponent<ItemTransaction> = {
  // pattern: new RegExp(`^pick up|get|grab(\\s(\\d+))?\\s+(${itemNames.join('|')})$`, 'i'),
  pattern: new RegExp(`^(pick up|get|grab)(\\s+(\\d+))?\\s+(${itemNames.join('|')})$`, 'i'),
  parse(text: string, actor: Animal.Animal, timestamp: number): ItemTransaction {
    const matches = text.match(this.pattern);

    if (!matches) {
      throw new Error(`Could not parse PickupAction: ${text}`);
    } else {
      const maybeItemName = matches[ 4 ];
      const itemName = stringToItemName(maybeItemName);

      if (!itemName) {
        throw new Error(`Item name not found: ${text}`);
      }

      let transactionAmount: number | undefined;

      if (matches[ 3 ]) {
        transactionAmount = parseInt(matches[ 3 ], 10);

        if (isNaN(transactionAmount)) {
          throw new Error(`Could not parse count: ${text}`);
        }
      } else {
        transactionAmount = undefined;
      }

      return {
        actor,
        timestamp,
        itemName,
        transactionAmount,
        key: 'Pickup'
      };
    }
  },
  validate(pickupAction: ItemTransaction, game: Game): ValidationResult {
    const cell = Map.getCell(game.map, pickupAction.actor);

    if (!Cell.isRoom(cell)) {
      throw new Error(`Actor is not in a room!`);
    }

    if (!Item.hasItem(cell.items, pickupAction.itemName)) {
      return {
        isValid: false,
        error: `${pickupAction.itemName} is not in the room!`
      };
    }

    const stackToPickUp = Item.getItem(cell.items, pickupAction.itemName) !;

    let amountToPickUp: number;

    if (pickupAction.transactionAmount !== undefined) {
      if (isFinite(pickupAction.transactionAmount)) {
        if (pickupAction.transactionAmount < 1) {
          return {
            isValid: false,
            error: 'Transaction amount must be positive!'
          };
        } else {
          amountToPickUp = pickupAction.transactionAmount;
        }
      } else {
        throw new Error(`Transaction amount exists but is not finite!`);
      }
    } else {
      amountToPickUp = stackToPickUp.stackAmount;
    }

    if (stackToPickUp.stackAmount < amountToPickUp) {
      return {
        isValid: false,
        error: `There is only ${stackToPickUp.stackAmount} ${stackToPickUp.item.name}(s) in the room!`
      };
    }

    if (Inventory.inventoryIsFull(pickupAction.actor.inventory)) {
      if (Inventory.hasItem(pickupAction.actor.inventory, pickupAction.itemName)) {
        const playerStack = Inventory.getItem(pickupAction.actor.inventory, pickupAction.itemName) !;
        if (Item.stackIsFull(playerStack)) {
          return {
            isValid: false,
            error: `Your current stack of ${pickupAction.itemName} is full!`
          };
        } else if (playerStack.stackAmount + amountToPickUp > playerStack.maxStackAmount) {
          return {
            isValid: false,
            error: `You can only hold ${playerStack.maxStackAmount} ${playerStack.item.name}(s)!`
          };
        } else {
          return {
            isValid: true
          };
        }
      } else {
        return {
          isValid: false,
          error: 'You inventory is full!'
        };
      }
    }
    return {
      isValid: true
    };
  },
  perform(pickupAction: ItemTransaction, game: Game, log: string[]): PerformResult {
    const messages: Messaging.Message[] = [];

    const room = Map.getCell(game.map, pickupAction.actor) as Cell.Room;

    const stackToPickUp = Item.getItem(room.items, pickupAction.itemName) !;

    let amountToPickUp: number;

    if (pickupAction.transactionAmount) {
      amountToPickUp = pickupAction.transactionAmount;
    } else {
      amountToPickUp = stackToPickUp.stackAmount;
    }

    stackToPickUp.stackAmount -= amountToPickUp;

    room.items = Item.removeEmptyStacks(room.items);

    const newActorStack = Item.createItemStack(stackToPickUp.item, amountToPickUp, stackToPickUp.maxStackAmount);

    pickupAction.actor.inventory.itemStacks.push(newActorStack);

    pickupAction.actor.inventory.itemStacks = Item.mergeStacks(pickupAction.actor.inventory.itemStacks);

    log.push(`After PickupAction: Room (${room.row}, ${room.col}) has items: ${JSON.stringify(room.items)}`);

    if (Character.isPlayerCharacter(pickupAction.actor) && game.hasPlayer(pickupAction.actor.playerId)) {
      const player = game.getPlayer(pickupAction.actor.playerId) !;

      messages.push(
        Messaging.createGameMessage(`You picked up ${amountToPickUp} ${stackToPickUp.item.name}(s).`, [ player ])
      );
    }

    return { messages, log };
  },
  componentKey: 'Pickup'
};

export const DROP_ACTION: ActionParserComponent<ItemTransaction> = {
  pattern: new RegExp(`drop(\\s+(\\d+))?\\s+(${itemNames.join('|')})`, 'i'),
  parse(text: string, actor: Animal.Animal, timestamp: number): ItemTransaction {
    const matches = text.match(this.pattern);

    if (!matches) {
      throw new Error(`Could not parse DropAction: ${text}`);
    } else {
      const itemName = stringToItemName(matches[ 3 ]);

      if (!itemName) {
        throw new Error(`Item name not found: ${matches[ 3 ]}`);
      }

      let dropCount: number | undefined;

      if (matches[ 2 ]) {
        dropCount = parseInt(matches[ 2 ], 10);

        if (isNaN(dropCount)) {
          throw new Error(`Could not parse drop count: ${matches[ 2 ]}`);
        }
      } else {
        dropCount = undefined;
      }

      return {
        actor,
        timestamp,
        itemName,
        transactionAmount: dropCount,
        key: 'Drop'
      };
    }
  },
  validate(dropAction: ItemTransaction, game: Game): ValidationResult {
    const cell = Map.getCell(game.map, dropAction.actor);

    if (!Cell.isRoom(cell)) {
      throw new Error(`Actor is not in a room!`);
    }

    if (!Inventory.hasItem(dropAction.actor.inventory, dropAction.itemName)) {
      return {
        isValid: false,
        error: `You do not have any ${dropAction.itemName} to drop!`
      };
    }

    // TODO: case where inventory contains multiple stacks of the same item?
    const stackToDrop = Inventory.getItem(dropAction.actor.inventory, dropAction.itemName) !;

    if (dropAction.transactionAmount !== undefined) {
      if (!isFinite(dropAction.transactionAmount)) {
        throw new Error(`Drop count ${dropAction.transactionAmount} exists but is not finite`);
      }

      if (dropAction.transactionAmount < 1) {
        return {
          isValid: false,
          error: `Drop count must be positive!`
        };
      }

      if (dropAction.transactionAmount > stackToDrop.stackAmount) {
        return {
          isValid: false,
          error: `You cannot drop more than ${stackToDrop.stackAmount} ${stackToDrop.item.name}!`
        };
      }
    }

    return {
      isValid: true
    };
  },
  perform(dropAction: ItemTransaction, game: Game, log: string[]): PerformResult {
    const messages: Messaging.Message[] = [];
    // first, remove the stack from the player's inventory
    const room = Map.getCell(game.map, dropAction.actor) as Cell.Room;
    const stackToRemove = Inventory.getItem(dropAction.actor.inventory, dropAction.itemName) !;

    // if the actor doesn't specify a dropCount, set it to the stack amount
    let amountToRemove: number;

    if (dropAction.transactionAmount) {
      amountToRemove = dropAction.transactionAmount;
    } else {
      amountToRemove = stackToRemove.stackAmount;
    }

    stackToRemove.stackAmount -= amountToRemove;

    dropAction.actor.inventory = Inventory.removeEmptyStacks(dropAction.actor.inventory);

    const dropStack = Item.createItemStack(stackToRemove.item, amountToRemove, stackToRemove.maxStackAmount);

    room.items.push(dropStack);

    room.items = Item.mergeStacks(room.items);

    log.push(`After DropAction: Room (${room.row}, ${room.col}) has items: ${JSON.stringify(room.items)}`);

    if (Character.isPlayerCharacter(dropAction.actor) && game.hasPlayer(dropAction.actor.playerId)) {
      const player = game.getPlayer(dropAction.actor.playerId) !;
      messages.push(
        Messaging.createGameMessage(`You dropped ${amountToRemove} ${stackToRemove.item.name}(s).`, [ player ])
      );
    }

    return { messages, log };
  },
  componentKey: 'Drop'
};

export interface ActionParserComponentMap<A extends Action> {
  [ componentKey: string ]: ActionParserComponent<A>;
};

export const PARSERS: ActionParserComponentMap<Action> = {
  Move: MOVE_COMPONENT,
  Pass: PASS_COMPONENT,
  Rest: REST_COMPONENT,
  Ingest: INGEST_COMPONENT,
  Attack: ATTACK_COMPONENT,
  Pickup: PICKUP_ACTION,
  Drop: DROP_ACTION
};

export function parseAction(text: string, actor: Animal.Animal, timestamp: number): (Action | null) {
  const myComponent = getComponentByText(text);

  if (!myComponent) {
    return null;
  }

  return myComponent.parse(text, actor, timestamp);
}

export function getComponentByText(text: string): (ActionParserComponent<Action> | undefined) {
  return _.find(PARSERS, comp => comp.pattern.test(text));
}

export function getComponentByKey(key: ComponentKey): ActionParserComponent<Action> {
  const component = PARSERS[ key ];

  if (component) {
    return component;
  } else {
    throw new Error(`Could not retrieve component for key: ${key}`);
  }
}

export function isParsableAction(text: string): boolean {
  return Boolean(getComponentByText(text));
}
