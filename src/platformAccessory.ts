import type {
  CharacteristicValue,
  PlatformAccessory,
  Service,
} from 'homebridge';

import type { RoombaPlatform } from './platform.js';

import {
  RoombaController,
  type RoombaState,
} from './roombaController.js';

/**
 * HomeKit representation of one Roomba.
 */
export class RoombaAccessory {

  private readonly controller: RoombaController;

  private readonly cleaningService: Service;
  private readonly roomServices =
    new Map<string, Service>();
  private readonly dockService: Service;
  private readonly batteryService: Service;
  private lastCleaningState = false;
  private activeRoomId?: string;

  constructor(
  private readonly platform: RoombaPlatform,
  private readonly accessory: PlatformAccessory,
  private readonly robotBlid: string,
  ) {

    this.controller =
  new RoombaController(
    this.platform.log,
    this.platform.config,
    this.robotBlid,
  );

    /**
     * Accessory information
     */
    this.accessory
      .getService(
        this.platform.Service.AccessoryInformation,
      )!
      .setCharacteristic(
        this.platform.Characteristic.Manufacturer,
        'iRobot',
      )
      .setCharacteristic(
        this.platform.Characteristic.Model,
        'Roomba',
      )
      .setCharacteristic(
        this.platform.Characteristic.SerialNumber,
        'Not Connected',
      );

    /**
     * Cleaning switch
     */
    this.cleaningService =
      this.accessory.getService('Cleaning') ||
      this.accessory.addService(
        this.platform.Service.Switch,
        'Cleaning',
        'roomba-cleaning',
      );

    this.cleaningService
      .setCharacteristic(
        this.platform.Characteristic.Name,
        'Cleaning',
      );

    this.cleaningService
      .getCharacteristic(
        this.platform.Characteristic.On,
      )
      .onSet(
        this.setCleaning.bind(this),
      )
      .onGet(
        this.getCleaning.bind(this),
      );

    /**
 * Return to Dock switch
 */
    this.dockService =
  this.accessory.getService('Return to Dock') ||
  this.accessory.addService(
    this.platform.Service.Switch,
    'Return to Dock',
    'roomba-dock',
  );

    this.dockService
      .setCharacteristic(
        this.platform.Characteristic.Name,
        'Return to Dock',
      );

    this.dockService
      .getCharacteristic(
        this.platform.Characteristic.On,
      )
      .onSet(
        this.setDock.bind(this),
      );
    /**
 * Battery
 */
    this.batteryService =
  this.accessory.getService(
    this.platform.Service.Battery,
  ) ||
  this.accessory.addService(
    this.platform.Service.Battery,
    'Roomba Battery',
  );

    /**
     * Listen for all state updates from RoombaController.
     */
    this.controller.onStateChange(
      this.handleStateUpdate.bind(this),
    );

    this.platform.log.info(
      `Roomba accessory ready: ${this.accessory.displayName}`,
      `Robot ID: ${this.robotBlid}`,
    );
    void this.controller
      .connect()
      .then(() => {

        this.configureRoomServices();

      })
      .catch((error: unknown) => {

        const message =
      error instanceof Error
        ? error.message
        : String(error);

        this.platform.log.error(
          `Roomba connection failed: ${message}`,
        );
      });
  }

  /**
   * Cleaning switch changed from Apple Home.
   */
  private async setCleaning(
    value: CharacteristicValue,
  ) {

    this.platform.log.info(
      `HomeKit Cleaning SET received: ${String(value)}`,
    );

    const requestedOn =
    value as boolean;

    if (requestedOn) {

      this.platform.log.info(
        'HomeKit Cleaning requested ON.',
      );

      await this.controller.startCleaning();

    } else {

      this.platform.log.info(
        'HomeKit Cleaning requested OFF.',
      );

      await this.controller.stopCleaning();
    }
  }

  /**
 * Kitchen/Dining switch changed from Apple Home.
 */
  
  private async getCleaning():
    Promise<CharacteristicValue> {

    return this.controller
      .getState()
      .isCleaning;
  }

  /**
   * Return-to-dock switch.
   *
   * This is treated as a momentary command.
   * Once triggered it automatically returns OFF.
   */
  private async setDock(
    value: CharacteristicValue,
  ) {

    const requestedOn =
      value as boolean;

    if (!requestedOn) {
      return;
    }

    await this.controller.returnToDock();

    this.dockService.updateCharacteristic(
      this.platform.Characteristic.On,
      false,
    );
  }

  /**
   * Push controller state into HomeKit.
   */
  /**
 * Create HomeKit switches for every named room
 * discovered from the active Roomba Smart Map.
 */
  private configureRoomServices(): void {

    const rooms =
    this.controller.getRooms();

    this.platform.log.info(
      `Configuring ${rooms.length} Roomba room service(s).`,
    );

    for (const room of rooms) {

      const subtype =
      `roomba-room-${room.id}`;

      const service =
      this.accessory.getServiceById(
        this.platform.Service.Switch,
        subtype,
      ) ||
      this.accessory.addService(
        this.platform.Service.Switch,
        room.name,
        subtype,
      );

      service.setCharacteristic(
        this.platform.Characteristic.Name,
        room.name,
      );

      service
        .getCharacteristic(
          this.platform.Characteristic.On,
        )
        .onSet(
          async (
            value: CharacteristicValue,
          ) => {

            await this.setRoomCleaning(
              room.id,
              room.name,
              value,
            );
          },
        );

      this.roomServices.set(
        room.id,
        service,
      );

      this.platform.log.info(
        `Roomba HomeKit room registered: ${room.name} [${room.id}]`,
      );
    }

    /**
     * Remove obsolete room switches that are no longer
     * present in the robot's current Smart Map.
     *
     * Preserve all current room subtypes and leave
     * Cleaning, Dock and Battery services untouched.
     */
    const validRoomSubtypes = new Set(
      rooms.map((room) => `roomba-room-${room.id}`),
    );

    for (const service of [...this.accessory.services]) {

      const subtype = service.subtype;

      if (
        service.UUID !== this.platform.Service.Switch.UUID ||
        !subtype?.startsWith('roomba-room-') ||
        validRoomSubtypes.has(subtype)
      ) {
        continue;
      }

      this.platform.log.info(
        `Removing obsolete Roomba room service: ${service.displayName}`,
      );

      this.accessory.removeService(service);
    }
  }

  /**
 * Generic mapped-room switch handler.
 */
  /**
 * Generic mapped-room switch handler.
 *
 * HomeKit can occasionally deliver duplicate SET events.
 * activeRoomId makes room commands idempotent so one tap
 * results in only one robot command.
 */
  private async setRoomCleaning(
    roomId: string,
    roomName: string,
    value: CharacteristicValue,
  ): Promise<void> {

    const requestedOn =
    value as boolean;

    this.platform.log.info(
      `HomeKit room SET received: ${roomName} [${roomId}] = ${String(requestedOn)}`,
    );

    if (requestedOn) {

      /**
     * Ignore duplicate ON events for the room
     * we already started.
     */
      if (this.activeRoomId === roomId) {

        this.platform.log.debug(
          `Ignoring duplicate HomeKit room ON: ${roomName} [${roomId}]`,
        );

        return;
      }

      /**
     * Record this BEFORE awaiting the MQTT command.
     * That blocks duplicate async SET callbacks immediately.
     */
      this.activeRoomId =
      roomId;

      try {

        await this.controller.startRoomCleaning(
          roomId,
        );

      } catch (error) {

        this.activeRoomId =
        undefined;

        throw error;
      }

      return;
    }

    /**
   * Ignore duplicate OFF events and OFF updates
   * generated when we synchronize HomeKit state.
   */
    if (this.activeRoomId !== roomId) {

      this.platform.log.debug(
        `Ignoring duplicate HomeKit room OFF: ${roomName} [${roomId}]`,
      );

      return;
    }

    this.platform.log.debug(
      `Room switch OFF ignored: ${roomName} [${roomId}]`,
    );

    return;
  }
  private handleStateUpdate(
    state: RoombaState,
  ) {

    this.cleaningService.updateCharacteristic(
      this.platform.Characteristic.On,
      state.isCleaning,
    );
    /**
 * When a cleaning mission finishes, reset all
 * mapped-room switches back to OFF.
 *
 * This only fires on a real cleaning -> idle transition,
 * so the selected room remains ON while the mission runs.
 */
    if (
      this.lastCleaningState &&
  !state.isCleaning &&
  this.activeRoomId !== undefined
    ) {

      /**
   * Clear this BEFORE updating HomeKit.
   * If HomeKit sends an OFF callback in response,
   * setRoomCleaning() will safely ignore it.
   */
      this.activeRoomId =
    undefined;

      for (const service of this.roomServices.values()) {

        service.updateCharacteristic(
          this.platform.Characteristic.On,
          false,
        );
      }

      this.platform.log.info(
        'Roomba room cleaning completed; room switches reset to OFF.',
      );
    }

    this.lastCleaningState =
  state.isCleaning;

    this.batteryService.updateCharacteristic(
      this.platform.Characteristic.BatteryLevel,
      state.batteryLevel,
    );

    this.batteryService.updateCharacteristic(
      this.platform.Characteristic.StatusLowBattery,
      state.batteryLevel <= 20
        ? this.platform.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
        : this.platform.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL,
    );

    this.batteryService.updateCharacteristic(
      this.platform.Characteristic.ChargingState,
      state.isCharging
        ? this.platform.Characteristic.ChargingState.CHARGING
        : this.platform.Characteristic.ChargingState.NOT_CHARGING,
    );

    this.platform.log.debug(
      'Roomba state:',
      `cleaning=${state.isCleaning}`,
      `docked=${state.isDocked}`,
      `charging=${state.isCharging}`,
      `battery=${state.batteryLevel}%`,
    );
  }
}