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
  /**
 * HomeKit accessories representing individual
 * Smart Map rooms.
 */
  private readonly roomAccessories =
    new Map<string, PlatformAccessory>(); 
  private readonly dockService: Service;
  private readonly batteryService: Service;
  private lastCleaningState = false;
  private activeRoomId?: string;

  constructor(
  private readonly platform: RoombaPlatform,
  private readonly accessory: PlatformAccessory,
  private readonly robotBlid: string,
  private readonly robotName: string,
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
    /**
 * Cleaning switch
 *
 * Standalone HomeKit accessory with its own name.
 */
    const cleaningAccessory =
  this.platform.getOrCreateControlAccessory(
    this.robotBlid,
    'cleaning',
    `${this.accessory.displayName} Cleaning`,
  );

    this.cleaningService =
  cleaningAccessory.getService(
    this.platform.Service.Switch,
  ) ||
  cleaningAccessory.addService(
    this.platform.Service.Switch,
    `${this.accessory.displayName} Cleaning`,
    'roomba-cleaning',
  );

    this.cleaningService.setCharacteristic(
      this.platform.Characteristic.Name,
      `${this.accessory.displayName} Cleaning`,
    );
    cleaningAccessory
      .getService(this.platform.Service.AccessoryInformation)
      ?.setCharacteristic(
        this.platform.Characteristic.Name,
        `${this.robotName} Cleaning`,
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

    this.platform.api.updatePlatformAccessories([
      cleaningAccessory,
    ]);
    /**
 * Return to Dock switch
 *
 * Standalone HomeKit accessory.
 */
    const dockAccessory =
  this.platform.getOrCreateControlAccessory(
    this.robotBlid,
    'dock',
    `${this.accessory.displayName} Return to Dock`,
  );
    dockAccessory
      .getService(this.platform.Service.AccessoryInformation)
      ?.setCharacteristic(
        this.platform.Characteristic.Name,
        `${this.robotName} Return to Dock`,
      );
    this.dockService =
  dockAccessory.getService(
    this.platform.Service.Switch,
  ) ||
  dockAccessory.addService(
    this.platform.Service.Switch,
    `${this.accessory.displayName} Return to Dock`,
    'roomba-dock',
  );

    this.dockService.setCharacteristic(
      this.platform.Characteristic.Name,
      `${this.accessory.displayName} Return to Dock`,
    );

    this.dockService
      .getCharacteristic(
        this.platform.Characteristic.On,
      )
      .onSet(
        this.setDock.bind(this),
      );

    this.platform.api.updatePlatformAccessories([
      dockAccessory,
    ]);
    /**
 * Remove legacy Cleaning and Dock switches
 * from the original Roomba accessory.
 *
 * Their replacements are now standalone accessories.
 */
    for (const service of [...this.accessory.services]) {

      if (
        service.subtype === 'roomba-cleaning' ||
    service.subtype === 'roomba-dock'
      ) {
        this.accessory.removeService(service);
      }

    }

    this.platform.api.updatePlatformAccessories([
      this.accessory,
    ]);
    /**
 * Battery
 */
    this.batteryService =
  this.accessory.getService(
    this.platform.Service.Battery,
  ) ||
  this.accessory.addService(
    this.platform.Service.Battery,
    'Battery',
  );
    this.batteryService.setCharacteristic(
      this.platform.Characteristic.Name,
      'Battery',
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

      if (this.activeRoomId !== undefined) {

        this.platform.log.info(
          'Ignoring general START: targeted room cleaning is active.',
        );

        return;
      }

      this.platform.log.info(
        'HomeKit Cleaning requested ON.',
      );

      await this.controller.startCleaning();

    } else {

      // Do not interrupt a targeted room cleaning mission.
      if (this.activeRoomId !== undefined) {

        this.platform.log.info(
          'Ignoring general STOP: targeted room cleaning is active.',
        );

        return;
      }

      // No need to STOP a robot that is already idle.
      const state = this.controller.getState();

      if (!state.isCleaning) {

        this.platform.log.debug(
          'Ignoring general STOP: robot is already idle.',
        );

        return;
      }

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
  ): Promise<void> {

    const requestedOn = value as boolean;

    if (!requestedOn) {
      return;
    }

    // Already docked — keep the switch OFF.
    const state = this.controller.getState();

    if (state.isDocked || state.isCharging) {

      this.dockService.updateCharacteristic(
        this.platform.Characteristic.On,
        false,
      );

      return;
    }

    // Send the docking command.
    await this.controller.returnToDock();
  }

  /**
   * Push controller state into HomeKit.
   */
  /**
 * Create HomeKit switches for every named room
 * discovered from the active Roomba Smart Map.
 */
  private configureRoomServices(): void {

    const rooms = this.controller.getRooms();

    this.platform.log.info(
      `Configuring ${rooms.length} Roomba room service(s).`,
    );
    /**
 * An empty Smart Map response may indicate a temporary
 * iRobot API or connection problem.
 *
 * Preserve existing HomeKit accessories rather than
 * deleting rooms until a valid map is available.
 */
    if (rooms.length === 0) {

      this.platform.log.warn(
        'Roomba Smart Map returned no rooms. ' +
    'Preserving existing HomeKit room accessories.',
      );

      return;
    }

    const validRoomIds = new Set(
      rooms.map(room => room.id),
    );

    for (const room of rooms) {

      const roomAccessory =
  this.platform.getOrCreateControlAccessory(
    this.robotBlid,
    `room-${room.id}`,
    room.name,
  );

      roomAccessory
        .getService(this.platform.Service.AccessoryInformation)
        ?.setCharacteristic(
          this.platform.Characteristic.Name,
          room.name,
        );

      this.roomAccessories.set(
        room.id,
        roomAccessory,
      );

      // Give each room its own named HomeKit Switch accessory.
      const roomSwitch =
      roomAccessory.getService(
        this.platform.Service.Switch,
      ) ||
      roomAccessory.addService(
        this.platform.Service.Switch,
        room.name,
      );

      roomSwitch.setCharacteristic(
        this.platform.Characteristic.Name,
        room.name,
      );

      roomSwitch
        .getCharacteristic(
          this.platform.Characteristic.On,
        )
        .onSet(async (value: CharacteristicValue) => {
          await this.setRoomCleaning(
            room.id,
            room.name,
            value,
          );
        });

      // Track the NEW service for cleaning-state updates.
      this.roomServices.set(
        room.id,
        roomSwitch,
      );

      this.platform.api.updatePlatformAccessories([
        roomAccessory,
      ]);

      this.platform.log.info(
        `Roomba HomeKit room registered: ${room.name} [${room.id}]`,
      );
    }

    /**
   * Remove the original room Switch services from
   * the robot accessory.
   *
   * Cleaning, Return to Dock and Battery are preserved.
   */
    for (const service of [...this.accessory.services]) {

      if (
        service.UUID !== this.platform.Service.Switch.UUID ||
      !service.subtype?.startsWith('roomba-room-')
      ) {
        continue;
      }

      this.platform.log.info(
        `Removing original Roomba room switch: ${service.displayName}`,
      );

      this.accessory.removeService(service);
    }

    /**
   * Remove room accessories from the current in-memory
   * tracking maps if their rooms are no longer present.
   *
   * Note: Homebridge cache unregistration of obsolete
   * standalone room accessories will be handled separately.
   */
    for (const roomId of [...this.roomAccessories.keys()]) {

      if (validRoomIds.has(roomId)) {
        continue;
      }

      this.roomAccessories.delete(roomId);
      this.roomServices.delete(roomId);
    }
    /**
 * Remove standalone room accessories that are
 * no longer present in the current Smart Map.
 *
 * Only affects this robot's obsolete rooms.
 */
    this.platform.removeObsoleteRoomAccessories(
      this.robotBlid,
      validRoomIds,
    );
    // Save the updated original robot accessory.
    this.platform.api.updatePlatformAccessories([
      this.accessory,
    ]);

    this.platform.log.info(
      'Roomba Smart Map room accessories saved to Homebridge.',
    );
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
    // Automatically reset Return to Dock
  // when the robot reaches its dock.
    if (state.isDocked || state.isCharging) {

      this.dockService.updateCharacteristic(
        this.platform.Characteristic.On,
        false,
      );
    }

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
      this.activeRoomId !== undefined &&
  this.lastCleaningState &&
  !state.isCleaning &&
  !state.isDocked &&
  !state.isCharging
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