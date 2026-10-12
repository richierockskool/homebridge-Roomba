import type { Logging } from 'homebridge';

import {
  V4MqttClient,
  type V4MqttMessage,
} from './v4MqttClient.js';

import type {
  V4Session,
  V4Robot,
} from './v4Authentication.js';

/**
 * Manages one shared MQTT connection per iRobot account.
 *
 * Each robot keeps its own V4MqttClient interface.
 * The underlying connection will be shared in the
 * next integration stage.
 */
export class V4MqttManager {

  private static readonly instances =
    new Map<string, V4MqttManager>();

  private readonly robots =
    new Map<string, V4Robot>();

  private mqttClient?: V4MqttClient;

  private connectPromise?: Promise<void>; 

  private readonly messageListeners =
    new Map<string, Set<(message: V4MqttMessage) => void>>();

  private constructor(
    private readonly log: Logging,
    private readonly session: V4Session,
  ) {
  }

  public static getInstance(
    log: Logging,
    session: V4Session,
  ): V4MqttManager {

    const key = session.iotClientId;

    let manager = this.instances.get(key);

    if (!manager) {

      manager = new V4MqttManager(
        log,
        session,
      );

      this.instances.set(key, manager);
    }

    return manager;
  }

  public async registerRobot(
    robot: V4Robot,
  ): Promise<void> {

    const alreadyRegistered =
    this.robots.has(robot.blid);

    this.robots.set(
      robot.blid,
      robot,
    );

    // If MQTT is already connected, subscribe
    // this robot without creating another connection.
    if (this.mqttClient && !alreadyRegistered) {

      await this.mqttClient.subscribeToRobotState(
        robot.blid,
      );

      await this.mqttClient.requestShadow(
        robot.blid,
      );
    }
  }

  public getRegisteredRobots(): V4Robot[] {

    return Array.from(
      this.robots.values(),
    );
  }

  public getRobotCount(): number {

    return this.robots.size;
  }
  public async connect(): Promise<void> {

    if (this.connectPromise) {
      await this.connectPromise;
      return;
    }

    if (this.mqttClient) {
      return;
    }

    this.connectPromise = this.openConnection();

    try {
      await this.connectPromise;
    } finally {
      this.connectPromise = undefined;
    }
    
  }
  public onRobotMessage(
    robotBlid: string,
    listener: (message: V4MqttMessage) => void,
  ): () => void {

    let listeners = this.messageListeners.get(robotBlid);

    if (!listeners) {
      listeners = new Set();
      this.messageListeners.set(robotBlid, listeners);
    }

    listeners.add(listener);

    return () => {
      listeners.delete(listener);

      if (listeners.size === 0) {
        this.messageListeners.delete(robotBlid);
      }
    };
  }
  private async openConnection(): Promise<void> {

    const robot = this.getRegisteredRobots()[0];

    if (!robot) {
      throw new Error(
        'Cannot connect MQTT without a registered Roomba.',
      );
    }

    const mqttClient = new V4MqttClient(
      this.log,
      this.session,
      robot,
    );
    mqttClient.onMessage((message) => {

      for (const [robotBlid, listeners] of this.messageListeners) {

        if (!message.topic.includes(`/things/${robotBlid}/`)) {
          continue;
        }

        for (const listener of listeners) {
          listener(message);
        }
      }
    });

    try {
      await mqttClient.connect();
      this.mqttClient = mqttClient;
    } catch (error) {
      await mqttClient.disconnect();
      throw error;
    }
  }
}
