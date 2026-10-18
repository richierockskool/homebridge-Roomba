import type {
  API,
  Characteristic,
  DynamicPlatformPlugin,
  Logging,
  PlatformAccessory,
  PlatformConfig,
  Service,
} from 'homebridge';

import { RoombaAccessory } from './platformAccessory.js';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js';
import {
  V4Authentication,
} from './transports/v4Authentication.js';

/**
 * RoombaPlatform
 *
 * Main Homebridge platform for Roomba Pro.
 *
 * This class owns Homebridge accessory registration.
 * Robot communication will be owned separately by RoombaController.
 */
export class RoombaPlatform implements DynamicPlatformPlugin {

  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;

  public readonly accessories: Map<string, PlatformAccessory> = new Map();

  /**
 * Remove standalone Roomba control accessories
 * that are no longer present in the current Smart Map.
 */
  public removeObsoleteRoomAccessories(
    robotBlid: string,
    validRoomIds: Set<string>,
  ): void {

    for (const [uuid, accessory] of this.accessories) {

      const control = accessory.context.roombaControl as
      | {
          robotBlid?: string;
          controlId?: string;
        }
      | undefined;

      if (
        control?.robotBlid !== robotBlid ||
      !control.controlId?.startsWith('room-')
      ) {
        continue;
      }

      const roomId = control.controlId.slice('room-'.length);

      if (validRoomIds.has(roomId)) {
        continue;
      }

      this.log.info(
        `Removing obsolete Roomba room accessory: ${accessory.displayName}`,
      );

      this.api.unregisterPlatformAccessories(
        PLUGIN_NAME,
        PLATFORM_NAME,
        [accessory],
      );

      this.accessories.delete(uuid);
    }
  }

  /**
 * Register or restore a named HomeKit control accessory.
 *
 * Uses a deterministic UUID so the same control is restored
 * rather than duplicated after a Homebridge restart.
 */
  public getOrCreateControlAccessory(
    robotBlid: string,
    controlId: string,
    controlName: string,
  ): PlatformAccessory {

    const uuid = this.api.hap.uuid.generate(
      `homebridge-roomba-pro-control-${robotBlid}-${controlId}`,
    );

    let accessory = this.accessories.get(uuid);

    if (accessory) {
      this.log.info(
        `Restoring Roomba control: ${controlName}`,
      );

      accessory.displayName = controlName;

      return accessory;
    }

    accessory = new this.api.platformAccessory(
      controlName,
      uuid,
    );

    accessory.context.roombaControl = {
      robotBlid,
      controlId,
    };

    this.api.registerPlatformAccessories(
      PLUGIN_NAME,
      PLATFORM_NAME,
      [accessory],
    );

    this.accessories.set(uuid, accessory);

    this.log.info(
      `Registered Roomba control: ${controlName}`,
    );

    return accessory;
  }

  constructor(
    public readonly log: Logging,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;

    this.log.info('Roomba Pro platform initializing...');

    this.api.on('didFinishLaunching', () => {
      this.log.info('Homebridge finished launching.');

      void this.discoverRoombas().catch(error => {
        const message =
      error instanceof Error
        ? error.message
        : String(error);

        this.log.error(
          `Roomba discovery failed: ${message}`,
        );
      });
    });
  }
  /**
   * Called by Homebridge when restoring an accessory from cache.
   */
  configureAccessory(accessory: PlatformAccessory) {
    this.log.info(
      'Loading Roomba accessory from cache:',
      accessory.displayName,
    );

    this.accessories.set(
      accessory.UUID,
      accessory,
    );
  }

  /**
   * Register or restore the primary Roomba accessory.
   *
   * For our first development stage we create one deterministic accessory.
   * Later this method will be replaced by real robot discovery.
   */
  /**
   * Discover and register each Roomba independently.
   */
  private async discoverRoombas(): Promise<void> {

    const email =
      typeof this.config.email === 'string'
        ? this.config.email.trim()
        : '';

    const password =
      typeof this.config.password === 'string'
        ? this.config.password
        : '';

    const countryCode =
      typeof this.config.countryCode === 'string'
        ? this.config.countryCode
        : 'CA';

    const authentication = new V4Authentication(
      this.log,
      {
        email,
        password,
        countryCode,
      },
    );

    const session = await authentication.authenticate();
    

    this.log.info(
      'iRobot MQTT client ID obtained successfully.',
    );

    if (session.robots.length === 0) {
      this.log.warn('No Roomba robots discovered.');
      return;
    }

    for (const robot of session.robots) {

      const isLittleBob =
        robot.blid ===
        '20F7790E082EFE7D6485D55ADCCC0AE8';

      const uuid = isLittleBob
        ? this.api.hap.uuid.generate(
          'homebridge-roomba-pro-primary',
        )
        : this.api.hap.uuid.generate(
          `homebridge-roomba-pro-${robot.blid}`,
        );

      const accessoryName = robot.name;

      this.log.info(
        `Roomba discovered name: "${accessoryName}"`,
      );

      let accessory = this.accessories.get(uuid);

      if (accessory) {

        this.log.info(
          `Restoring Roomba: ${accessoryName} (${robot.sku})`,
        );
        accessory.displayName = accessoryName;

        accessory.context.device = {
          id: robot.blid,
          name: accessoryName,
          sku: robot.sku,
        };

        this.api.updatePlatformAccessories([
          accessory,
        ]);

      } else {

        this.log.info(
          `Adding Roomba: ${accessoryName} (${robot.sku})`,
        );

        accessory = new this.api.platformAccessory(
          accessoryName,
          uuid,
        );
        accessory.displayName = accessoryName;

        accessory.context.device = {
          id: robot.blid,
          name: accessoryName,
          sku: robot.sku,
        };

        this.api.registerPlatformAccessories(
          PLUGIN_NAME,
          PLATFORM_NAME,
          [accessory],
        );

        this.accessories.set(uuid, accessory);
      }
      // Keep the HomeKit accessory name synchronized
      // with the robot's current name.
      const informationService =
        accessory.getService(
          this.Service.AccessoryInformation,
        );

      if (informationService) {
        informationService.setCharacteristic(
          this.Characteristic.Name,
          accessoryName,
        );
      }

      new RoombaAccessory(
        this,
        accessory,
        robot.blid,
        accessoryName,
      );
    }
  }
}