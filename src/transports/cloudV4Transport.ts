import type { Logging } from 'homebridge';

import type {
  RoombaTransport,
  RoombaTransportState,
  RoombaTransportStateListener,
} from './roombaTransport.js';

import {
  V4Authentication,
  type V4Credentials,
  type V4Session,
} from './v4Authentication.js';

import {
  V4MqttClient,
  type V4MqttMessage,
} from './v4MqttClient.js';

import {
  V4MapClient,
  type V4Room,
} from './v4MapClient.js';

/**
 * Cloud transport for newer V4-generation iRobot robots.
 */
export class CloudV4Transport implements RoombaTransport {

  public readonly name = 'iRobot Cloud V4';

  private state: RoombaTransportState = {
    isCleaning: false,
    isDocked: false,
    isCharging: false,
    batteryLevel: 0,
  };

  private readonly listeners =
    new Set<RoombaTransportStateListener>();

  private readonly authentication: V4Authentication;

  private session?: V4Session;
  private mqttClient?: V4MqttClient;
  private mapClient?: V4MapClient;

  private connected = false;
  private reconnectPromise?: Promise<void>;

  constructor(
    private readonly log: Logging,
    credentials: V4Credentials,
  ) {

    this.authentication =
      new V4Authentication(
        this.log,
        credentials,
      );
  }

  public async connect(): Promise<void> {

    if (this.connected) {
      return;
    }

    this.log.info(
      'Connecting iRobot Cloud V4 transport...',
    );

    /**
     * Step 1:
     * Authenticate with iRobot and obtain the
     * short-lived AWS IoT session.
     */
    const session =
      await this.authentication.authenticate();

    const robot =
      session.robots[0];

    if (!robot) {
      throw new Error(
        'No supported Roomba was returned by the iRobot account.',
      );
    }

    this.session =
      session;

    this.log.info(
      `Cloud V4 authenticated for ${robot.name} (${robot.sku}).`,
    );

    /**
     * Step 2:
     * Establish the live AWS IoT MQTT connection.
     */
    const mqttClient =
      new V4MqttClient(
        this.log,
        session,
        robot,
      );

    this.mapClient =
  new V4MapClient(
    this.log,
    session,
    robot,
  );

    await this.mapClient.discoverRooms();
    mqttClient.onMessage(
      this.handleMqttMessage.bind(this),
    );

    this.mqttClient =
      mqttClient;

    try {

      await mqttClient.connect();

    } catch (error) {

      this.mqttClient = undefined;
      this.session = undefined;

      throw error;
    }

    this.connected = true;

    

    this.log.info(
      `Cloud V4 transport fully connected to ${robot.name} (${robot.sku}).`,
    );
  }

  public async disconnect(): Promise<void> {

    this.connected = false;

    const mqttClient =
      this.mqttClient;

    this.mqttClient = undefined;
    this.session = undefined;
    this.mapClient = undefined;

    if (mqttClient) {
      await mqttClient.disconnect();
    }

    this.log.info(
      'Cloud V4 transport disconnected.',
    );
  }

  public async startCleaning(): Promise<void> {
    await this.sendCommand('start');
  }
  /**
 * Start a targeted P2 Smart Map room-cleaning mission.
 */
  public async startRoomCleaning(
    roomId: string,
  ): Promise<void> {

    if (
      !this.connected ||
    !this.mqttClient ||
    !this.mapClient
    ) {
      throw new Error(
        'Cloud V4 transport is not connected.',
      );
    }

    const mapInfo =
    this.mapClient.getMapInfo();

    if (!mapInfo) {
      throw new Error(
        'No active Roomba Smart Map is available.',
      );
    }

    const room =
    mapInfo.rooms.find(
      candidate =>
        candidate.id === roomId,
    );

    if (!room) {
      throw new Error(
        `Roomba room ${roomId} is not present on the active Smart Map.`,
      );
    }

    try {

      await this.mqttClient.sendRoomCleaningCommand(
        mapInfo.p2mapId,
        room.id,
      );

    } catch (error) {

      const message =
    error instanceof Error
      ? error.message
      : String(error);

      this.log.warn(
        `Roomba V4 room command failed: ${message}`,
      );

      await this.reconnect();

      const mqttClient =
    this.mqttClient;

      const refreshedMapInfo =
    this.mapClient?.getMapInfo();

      if (
        !mqttClient ||
    !refreshedMapInfo
      ) {
        throw new Error(
          'Roomba room command could not recover after reconnect.',
          {
            cause: error,
          },
        );
      }

      const refreshedRoom =
    refreshedMapInfo.rooms.find(
      candidate =>
        candidate.id === roomId,
    );

      if (!refreshedRoom) {
        throw new Error(
          `Roomba room ${roomId} was not found after reconnect.`,
          {
            cause: error,
          },
        );
      }

      this.log.info(
        `Retrying Roomba V4 room command: ${refreshedRoom.name} [${refreshedRoom.id}]`,
      );

      await mqttClient.sendRoomCleaningCommand(
        refreshedMapInfo.p2mapId,
        refreshedRoom.id,
      );
    }

    this.log.info(
      `Roomba V4 targeted room cleaning started: ${room.name} [${room.id}]`,
    );
  }
  public getRooms(): V4Room[] {

    return this.mapClient?.getRooms() ?? [];
  }

  public async pauseCleaning(): Promise<void> {
    await this.sendCommand('pause');
  }

  public async resumeCleaning(): Promise<void> {
    await this.sendCommand('resume');
  }

  public async stopCleaning(): Promise<void> {
    await this.sendCommand('stop');
  }

  public async returnToDock(): Promise<void> {
    await this.sendCommand('dock');
  }

  public getState(): RoombaTransportState {

    return {
      ...this.state,
    };
  }

  public onStateChange(
    listener: RoombaTransportStateListener,
  ): void {

    this.listeners.add(listener);

    listener(
      this.getState(),
    );
  }

  /**
   * Receive raw MQTT traffic from the Roomba.
   *
   * For this checkpoint we intentionally log the topic
   * and payload only.
   *
   * Once we know the exact Roomba 105 shadow structure,
   * the next patch will normalize battery, mission,
   * dock and charging state.
   */
  private handleMqttMessage(
    message: V4MqttMessage,
  ): void {

    this.log.debug(
      `Roomba V4 MQTT topic: ${message.topic}`,
    );

    if (message.payload.length === 0) {
      return;
    }

    let payload: unknown;

    try {

      payload =
      JSON.parse(
        message.payload,
      );

    } catch {

      this.log.warn(
        `Roomba V4 MQTT payload was not valid JSON: ${message.topic}`,
      );

      return;
    }

    if (
      typeof payload !== 'object' ||
    payload === null
    ) {
      return;
    }

    const root =
    payload as Record<string, unknown>;

    const state =
    this.getObject(
      root.state,
    );

    const reported =
    this.getObject(
      state?.reported,
    );

    if (!reported) {
      return;
    }

    /**
   * ro-currentstate
   */
    if (
      message.topic.includes(
        '/shadow/name/ro-currentstate/',
      )
    ) {

      const batteryLevel =
      this.getNumber(
        reported.batPct,
      );

      const missionStatus =
      this.getObject(
        reported.cleanMissionStatus,
      );

      const phase =
      this.getString(
        missionStatus?.phase,
      );

      const cycle =
      this.getString(
        missionStatus?.cycle,
      );

      const changes:
Partial<RoombaTransportState> = {};

      if (batteryLevel !== undefined) {

        changes.batteryLevel =
    Math.max(
      0,
      Math.min(
        100,
        Math.round(
          batteryLevel,
        ),
      ),
    );
      }

      /**
 * Mission state updates can be partial.
 *
 * Only change cleaning / charging / docked state
 * when phase or cycle is actually present.
 *
 * This prevents battery-only MQTT updates from
 * incorrectly clearing an active cleaning mission.
 */
      if (
        phase !== undefined ||
  cycle !== undefined
      ) {

        changes.isCleaning =
    phase === 'run' ||
    phase === 'resume' ||
    cycle === 'clean';

        changes.isCharging =
    phase === 'charge';

        changes.isDocked =
    phase === 'charge' ||
    phase === 'dock';
      }

      this.updateState(
        changes,
      );

      this.log.info(
        'Roomba state updated:',
        `battery=${this.state.batteryLevel}%`,
        `cleaning=${this.state.isCleaning}`,
        `charging=${this.state.isCharging}`,
        `docked=${this.state.isDocked}`,
        `phase=${phase ?? 'unknown'}`,
        `cycle=${cycle ?? 'unknown'}`,
      );

      return;
    }

    /**
   * rw-constatus
   */
    if (
      message.topic.includes(
        '/shadow/name/rw-constatus/',
      )
    ) {

      const connected =
      this.getBoolean(
        reported.connected,
      );

      if (connected !== undefined) {

        this.log.debug(
          `Roomba cloud connection state: connected=${connected}`,
        );
      }
    }
  }
  private updateState(
    changes: Partial<RoombaTransportState>,
  ): void {

    this.state = {
      ...this.state,
      ...changes,
    };

    const snapshot =
    this.getState();

    for (const listener of this.listeners) {
      listener(snapshot);
    }
  }

  private getObject(
    value: unknown,
  ): Record<string, unknown> | undefined {

    if (
      typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value)
    ) {
      return value as Record<string, unknown>;
    }

    return undefined;
  }

  private getString(
    value: unknown,
  ): string | undefined {

    if (
      typeof value === 'string' &&
    value.length > 0
    ) {
      return value;
    }

    return undefined;
  }

  private getNumber(
    value: unknown,
  ): number | undefined {

    if (
      typeof value === 'number' &&
    Number.isFinite(value)
    ) {
      return value;
    }

    return undefined;
  }

  private getBoolean(
    value: unknown,
  ): boolean | undefined {

    if (typeof value === 'boolean') {
      return value;
    }

    return undefined;
  }
  /**
 * Rebuild the V4 cloud session and MQTT connection.
 *
 * iRobot V4 credentials are short-lived, so a stale
 * MQTT connection must be recovered with fresh
 * authentication rather than simply reusing the
 * existing session.
 */
  private async reconnect(): Promise<void> {

    if (this.reconnectPromise) {
      await this.reconnectPromise;
      return;
    }

    this.reconnectPromise =
    this.performReconnect();

    try {
      await this.reconnectPromise;
    } finally {
      this.reconnectPromise =
      undefined;
    }
  }

  /**
 * Perform one complete V4 reconnection.
 */
  private async performReconnect(): Promise<void> {

    this.log.warn(
      'Reconnecting iRobot Cloud V4 transport...',
    );

    this.connected = false;

    const oldMqttClient =
    this.mqttClient;

    this.mqttClient =
    undefined;

    if (oldMqttClient) {

      try {
        await oldMqttClient.disconnect();
      } catch (error) {

        const message =
        error instanceof Error
          ? error.message
          : String(error);

        this.log.debug(
          `Old Roomba MQTT disconnect failed during reconnect: ${message}`,
        );
      }
    }

    /**
   * Obtain completely fresh iRobot/AWS credentials.
   */
    const session =
    await this.authentication.authenticate();

    const robot =
    session.robots[0];

    if (!robot) {
      throw new Error(
        'No supported Roomba was returned during V4 reconnect.',
      );
    }

    const mqttClient =
    new V4MqttClient(
      this.log,
      session,
      robot,
    );

    mqttClient.onMessage(
      this.handleMqttMessage.bind(this),
    );

    await mqttClient.connect();

    this.session =
    session;

    this.mqttClient =
    mqttClient;

    /**
   * Refresh the Smart Map as well because room/map
   * information may have changed while disconnected.
   */
    const mapClient =
    new V4MapClient(
      this.log,
      session,
      robot,
    );

    await mapClient.discoverRooms();

    this.mapClient =
    mapClient;

    this.connected = true;

    this.log.info(
      'iRobot Cloud V4 transport reconnected successfully.',
    );
  }
  private async sendCommand(
    command: string,
  ): Promise<void> {

    try {

      if (
        !this.connected ||
      !this.session ||
      !this.mqttClient
      ) {
        throw new Error(
          'Cloud V4 transport is not connected.',
        );
      }

      await this.mqttClient.sendCommand(
        command,
      );

    } catch (error) {

      const message =
      error instanceof Error
        ? error.message
        : String(error);

      this.log.warn(
        `Roomba V4 command "${command}" failed: ${message}`,
      );

      await this.reconnect();

      const mqttClient =
      this.mqttClient;

      if (!mqttClient) {
        throw new Error(
          'Roomba MQTT client was unavailable after reconnect.',
          {
            cause: error,
          },
        );
      }

      this.log.info(
        `Retrying Roomba V4 command: ${command}`,
      );

      await mqttClient.sendCommand(
        command,
      );
    }

    this.log.info(
      `Roomba V4 command sent: ${command}`,
    );
  }
}