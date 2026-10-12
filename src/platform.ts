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
      `Preparing ${session.robots.length} Roomba accessory(s).`,
    );

    for (const robot of session.robots) {
      this.log.info(
        `Roomba accessory candidate: ${robot.name} (${robot.sku})`,
      );
    }

  // Accessory registration will follow in the next patch.
  }
  private setupRoombaAccessory() {

    const accessoryName =
      typeof this.config.name === 'string' &&
      this.config.name.trim().length > 0
        ? this.config.name.trim()
        : 'Roomba';

    const uuid = this.api.hap.uuid.generate(
      'homebridge-roomba-pro-primary',
    );

    const existingAccessory =
      this.accessories.get(uuid);

    if (existingAccessory) {

      this.log.info(
        'Restoring Roomba:',
        existingAccessory.displayName,
      );

      existingAccessory.context.device = {
        id: 'primary',
        name: accessoryName,
      };

      this.api.updatePlatformAccessories([
        existingAccessory,
      ]);

      new RoombaAccessory(
        this,
        existingAccessory,
      );

      return;
    }

    this.log.info(
      'Adding Roomba accessory:',
      accessoryName,
    );

    const accessory =
      new this.api.platformAccessory(
        accessoryName,
        uuid,
      );

    accessory.context.device = {
      id: 'primary',
      name: accessoryName,
    };

    new RoombaAccessory(
      this,
      accessory,
    );

    this.api.registerPlatformAccessories(
      PLUGIN_NAME,
      PLATFORM_NAME,
      [accessory],
    );

    this.accessories.set(
      accessory.UUID,
      accessory,
    );
  }
}