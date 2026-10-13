import type { Logging } from 'homebridge';

import type {
  RoombaTransport,
  RoombaTransportState,
  RoombaTransportStateListener,
} from './roombaTransport.js';

import {
  V4Authentication,
  type V4Credentials,
} from './v4Authentication.js';

import type {
  V4MqttMessage,
} from './v4MqttClient.js';

import {
  V4MqttManager,
} from './v4MqttManager.js';

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

  

  private mqttManager?: V4MqttManager;
  private acquiredRobotBlid?: string;
  private unsubscribeMqtt?: () => void;
  private mapClient?: V4MapClient;

  private connected = false;
  private reconnectPromise?: Promise<void>;

  constructor(
  private readonly log: Logging,
  credentials: V4Credentials,
  private readonly robotBlid?: string,
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

    const robot = this.robotBlid
      ? session.robots.find(
        candidate => candidate.blid === this.robotBlid,
      )
      : session.robots[0];

    if (!robot) {
      throw new Error(
        this.robotBlid
          ? `Configured Roomba ${this.robotBlid} was not found in the iRobot account.`
          : 'No supported Roomba was returned by the iRobot account.',
      );
    }
   

    this.log.info(
      `Cloud V4 authenticated for ${robot.name} (${robot.sku}).`,
    );

    /**
     * Step 2:
     * Establish the live AWS IoT MQTT connection.
     */
    const mqttManager =
  V4MqttManager.getInstance(
    this.log,
    session,
  );

    // Allow the shared manager to renew
    // the iRobot account session.
    mqttManager.setAuthentication(
      this.authentication,
    );

    mqttManager.registerRobot(robot);

    this.mapClient =
  new V4MapClient(
    this.log,
    session,
    robot,
  );

    await this.mapClient.discoverRooms();

    this.mqttManager = mqttManager;

    this.unsubscribeMqtt = mqttManager.onRobotMessage(
      robot.blid,
      this.handleMqttMessage.bind(this),
    );

    try {

      await mqttManager.acquireRobot(robot);
      this.acquiredRobotBlid = robot.blid;

    } catch (error) {

      this.mqttManager = undefined;

      this.unsubscribeMqtt?.();
      this.unsubscribeMqtt = undefined;

      throw error;

    }
    this.connected = true;

    

    this.log.info(
      `Cloud V4 transport fully connected to ${robot.name} (${robot.sku}).`,
    );
  }

  public async disconnect(): Promise<void> {

    this.connected = false;

    // Stop receiving messages for this robot.
    this.unsubscribeMqtt?.();
    this.unsubscribeMqtt = undefined;

    // Release only this robot's ownership.
    // The other robot keeps the shared connection.
    const mqttManager = this.mqttManager;
    this.mqttManager = undefined;

    
    
    this.mapClient = undefined;

    const acquiredRobotBlid = this.acquiredRobotBlid;
    this.acquiredRobotBlid = undefined;

    if (mqttManager && acquiredRobotBlid) {
      await mqttManager.releaseRobot(acquiredRobotBlid);
    }

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
  !this.mqttManager ||
  !this.robotBlid ||
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

      await this.mqttManager!.sendRoomCleaningCommand(
    this.robotBlid!,
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

      throw error;

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

    // Only process messages belonging to this robot.
    // This is essential when multiple Roombas share MQTT.
    if (
      this.robotBlid &&
    !message.topic.includes(
      `/things/${this.robotBlid}/`,
    )
    ) {
      return;
    }

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
      'Refreshing iRobot Cloud V4 transport...',
    );

    this.connected = false;

    // Obtain fresh authentication credentials.
    const session =
    await this.authentication.authenticate();

    const robot = this.robotBlid
      ? session.robots.find(
        candidate => candidate.blid === this.robotBlid,
      )
      : session.robots[0];

    if (!robot) {
      throw new Error(
        'Configured Roomba was not found during V4 reconnect.',
      );
    }

    // Reuse the account's existing MQTT manager.
    // Never create a competing MQTT client.
    const mqttManager =
    V4MqttManager.getInstance(
      this.log,
      session,
    );

    // Refresh robot registration and session credentials.
    mqttManager.registerRobot(robot);

    // The manager owns the MQTT connection.
    // If this robot is already active, acquireRobot()
    // will leave the existing connection untouched.
    await mqttManager.acquireRobot(robot);
    this.acquiredRobotBlid = robot.blid;
  

    // Refresh this robot's Smart Map independently.
    const mapClient = new V4MapClient(
      this.log,
      session,
      robot,
    );

    await mapClient.discoverRooms();

    // Replace any previous message listener.
    this.unsubscribeMqtt?.();

    this.unsubscribeMqtt =
    mqttManager.onRobotMessage(
      robot.blid,
      this.handleMqttMessage.bind(this),
    );

    this.mqttManager = mqttManager;
    this.mapClient = mapClient;

    this.connected = true;

    this.log.info(
      `iRobot Cloud V4 transport refreshed: ${robot.name}.`,
    );

  }
  private async sendCommand(
    command: string,
  ): Promise<void> {

    if (
      !this.connected ||
    !this.mqttManager ||
    !this.robotBlid
    ) {
      throw new Error(
        'Cloud V4 transport is not connected.',
      );
    }

    try {

      await this.mqttManager.sendCommand(
        this.robotBlid,
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

      // Do not automatically retry.
      // The original command may have reached the robot.
      throw error;

    }

    this.log.info(
      `Roomba V4 command sent: ${command}`,
    );

  }
}