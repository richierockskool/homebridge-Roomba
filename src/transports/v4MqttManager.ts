import type { Logging } from 'homebridge';

import {
  V4MqttClient,
  type V4MqttMessage,
} from './v4MqttClient.js';

import {
  type V4Authentication,
  type V4Session,
  type V4Robot,
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

  private disconnectPromise?: Promise<void>;

  private shutdownComplete?: Promise<void>;

  private finishShutdown?: () => void;

  private restorePromise?: Promise<void>;

  private renewalTimer?: ReturnType<typeof setTimeout>;

  private renewalPromise?: Promise<void>;

  private readonly activeRobots = new Set<string>();

  private readonly pendingRobots = new Set<string>();

  private readonly cancelledRobots = new Set<string>();

  private readonly messageListeners =
    new Map<string, Set<(message: V4MqttMessage) => void>>();

  private authentication?: V4Authentication;  

  private constructor(
  private readonly log: Logging,
  private session: V4Session,
  ) {
  }
  public setAuthentication(
    authentication: V4Authentication,
  ): void {

    this.authentication = authentication;

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

    } else {

      manager.updateSession(session);

    }

    return manager;
  }
  public updateSession(
    session: V4Session,
  ): void {

    const oldClientId = this.session.iotClientId;
    const newClientId = session.iotClientId;

    if (oldClientId !== newClientId) {

      // Prevent accidentally taking over another manager.
      const existingManager =
      V4MqttManager.instances.get(newClientId);

      if (
        existingManager &&
      existingManager !== this
      ) {
        throw new Error(
          'MQTT client ID is already assigned to another manager.',
        );
      }

      // Update the shared manager's registry key.
      V4MqttManager.instances.delete(oldClientId);

      V4MqttManager.instances.set(
        newClientId,
        this,
      );

      this.log.info(
        'Roomba MQTT client ID updated during authentication renewal.',
      );
    }

    // Retain the same manager and all registered robots.
    this.session = session;
  }
  public registerRobot(
    robot: V4Robot,
  ): void {

    this.robots.set(
      robot.blid,
      robot,
    );
  }

  public getRegisteredRobots(): V4Robot[] {

    return Array.from(
      this.robots.values(),
    );
  }

  public getRobotCount(): number {

    return this.robots.size;
  }
  public async acquireRobot(
    robot: V4Robot,
  ): Promise<void> {

    // Wait until any shared MQTT shutdown completes.
    
    // Wait for a shutdown already in progress.
    if (this.shutdownComplete) {
      await this.shutdownComplete;
    }

    // This robot already owns a connection.
    // Do not subscribe it a second time.
    if (this.activeRobots.has(robot.blid)) {
      return;
    }
    // Prevent overlapping acquisitions for
    // the same robot.
    if (this.pendingRobots.has(robot.blid)) {
      throw new Error(
        'Roomba MQTT acquisition is already in progress.',
      );
    }

    this.pendingRobots.add(robot.blid);

    // Your existing try block continues here.

    try {

      this.registerRobot(robot);

      await this.connect();

      // The robot may have been released while
      // the shared connection was being established.
      if (this.cancelledRobots.has(robot.blid)) {
        throw new Error(
          'Roomba MQTT acquisition was cancelled during connection.',
        );
      }

      const mqttClient = this.mqttClient;

      if (!mqttClient) {
        throw new Error(
          'Shared Roomba MQTT connection is unavailable.',
        );
      }

      await mqttClient.subscribeToRobotState(
        robot.blid,
      );

      await mqttClient.requestShadow(
        robot.blid,
      );

      
      // Never complete an acquisition that was cancelled.
      if (this.cancelledRobots.has(robot.blid)) {
        throw new Error(
          'Roomba MQTT acquisition was cancelled during startup.',
        );
      }

      this.activeRobots.add(robot.blid);
      // Start one shared authentication renewal timer
      // after the first robot becomes active.
      if (
        this.activeRobots.size === 1 &&
  !this.renewalTimer &&
  !this.renewalPromise
      ) {
        this.scheduleRenewal();
      }

    } finally {

      const wasCancelled =
    this.cancelledRobots.has(robot.blid);

      const becameActive =
    this.activeRobots.has(robot.blid);

      this.pendingRobots.delete(robot.blid);

      this.cancelledRobots.delete(robot.blid);

      // Clean up a cancelled or failed acquisition.
      // Never close MQTT while another robot needs it.
      if (wasCancelled || !becameActive) {
        await this.releaseRobot(robot.blid);
      }
    }
  }

  public async releaseRobot(
    robotBlid: string,
  ): Promise<void> {

    // Another shutdown is already underway.
    // Let it finish rather than starting a second one.
    // Wait for any existing shutdown to finish
    // before processing this robot's release.
    // Record this robot's release immediately.
    if (this.pendingRobots.has(robotBlid)) {
      this.cancelledRobots.add(robotBlid);
    }
    // Cancel scheduled renewal when the last robot
    // is being released.
    if (
      this.activeRobots.size === 1 &&
  this.activeRobots.has(robotBlid) &&
  this.pendingRobots.size === 0
    ) {
      if (this.renewalTimer) {
        clearTimeout(this.renewalTimer);
        this.renewalTimer = undefined;
      }
    }

    this.activeRobots.delete(robotBlid);

    // Allow an in-progress credential renewal
    // to finish before shutting down MQTT.
    if (this.renewalPromise) {
      try {
        await this.renewalPromise;
      } catch {
        // Renewal errors are logged by the scheduler.
        // Continue releasing the robot safely.
      }
    }

    // Finish any shutdown already underway.
    if (this.shutdownComplete) {
      await this.shutdownComplete;
    }

    if (this.connectPromise) {
      try {
        await this.connectPromise;
      } catch {
        // Connection failure is handled by connect().
      }
    }

    // Another release may have started shutdown
    // while we were waiting for the connection.
    if (this.shutdownComplete) {
      await this.shutdownComplete;
      return;
    }

    // Keep MQTT running while another robot
    // is active or still connecting.
    if (
      this.activeRobots.size > 0 ||
  this.pendingRobots.size > 0
    ) {
      return;
    }
   
    // No scheduled authentication renewal may survive
    // shutdown of the shared MQTT connection.
    if (this.renewalTimer) {
      clearTimeout(this.renewalTimer);
      this.renewalTimer = undefined;
    }

    this.shutdownComplete = new Promise<void>((resolve) => {
      this.finishShutdown = resolve;
    });

    try {
      const mqttClient = this.mqttClient;

      this.mqttClient = undefined;

      if (mqttClient) {
        const disconnectPromise = mqttClient.disconnect();

        this.disconnectPromise = disconnectPromise;

        try {
          await disconnectPromise;
        } finally {
          if (this.disconnectPromise === disconnectPromise) {
            this.disconnectPromise = undefined;
          }
        }
      }
    } finally {
      

      this.finishShutdown?.();
      this.finishShutdown = undefined;
      this.shutdownComplete = undefined;
    }
  }
  public connect(): Promise<void> {

    if (this.connectPromise) {
      return this.connectPromise;
    }

    if (
      this.mqttClient &&
  !this.shutdownComplete &&
  this.mqttClient.isConnected()
    ) {
      return Promise.resolve();
    }

    const connection = (async (): Promise<void> => {

      if (this.shutdownComplete) {
        await this.shutdownComplete;
      }

      if (this.disconnectPromise) {
        await this.disconnectPromise;
      }

      if (this.mqttClient) {

        // The existing AWS IoT MQTT5 client manages
        // its own automatic reconnection.
        //
        // Never create a second client while the
        // original client is still running.
        if (!this.mqttClient.isConnected()) {
          this.log.warn(
            'Shared Roomba MQTT client is disconnected. ' +
      'Waiting for AWS IoT automatic reconnection.',
          );
        }

        return;
      }

      await this.openConnection();

    })();

    this.connectPromise = connection;

    void connection.finally(() => {
      if (this.connectPromise === connection) {
        this.connectPromise = undefined;
      }
    }).catch(() => {
    // The original connection promise carries the error.
    });

    return connection;
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
  public async sendCommand(
    robotBlid: string,
    command: string,
  ): Promise<void> {

    if (!this.activeRobots.has(robotBlid)) {
      throw new Error(
        'Roomba does not have an active MQTT connection',
      );
    }

    if (!this.mqttClient) {
      throw new Error(
        'Shared Roomba MQTT connection is unavailable.',
      );
    }
    await this.mqttClient.waitForConnection();


    await this.mqttClient.sendCommand(
      command,
      robotBlid,
    );
  }

  public async sendRoomCleaningCommand(
    robotBlid: string,
    p2mapId: string,
    roomId: string,
  ): Promise<void> {

    if (!this.activeRobots.has(robotBlid)) {
      throw new Error(
        'Roomba does not have an active MQTT connection.',
      );
    }

    if (!this.mqttClient) {
      throw new Error(
        'Shared Roomba MQTT connection is unavailable.',
      );
    }
    await this.mqttClient.waitForConnection();

    await this.mqttClient.sendRoomCleaningCommand(
      p2mapId,
      roomId,
      robotBlid,
    );
  }
  private scheduleRenewal(
    delayMs = 50 * 60 * 1000,
  ): void {

    if (this.renewalTimer) {
      clearTimeout(this.renewalTimer);
    }

    // Renew before the observed 60-minute expiry.
    this.renewalTimer = setTimeout(() => {

      this.renewalTimer = undefined;

      if (this.renewalPromise) {
        return;
      }
      let renewalFailed = false;

      const renewal = this.renewConnection();

      this.renewalPromise = renewal;

      void renewal
        .catch((error) => {

          renewalFailed = true;

          this.log.error(
            `Roomba MQTT credential renewal failed: ${String(error)}`,
          );

        })
        .finally(() => {
          if (this.renewalPromise === renewal) {
            this.renewalPromise = undefined;
          }

          // Schedule the next renewal only while
          // robots still require the connection.
          if (
            this.activeRobots.size > 0 &&
  !this.shutdownComplete &&
  !this.disconnectPromise
          ) {

            if (renewalFailed) {

              // Retry authentication after 60 seconds.
              this.scheduleRenewal(60 * 1000);

            } else {

              // Successful renewal: schedule the next
              // credential refresh in 50 minutes.
              this.scheduleRenewal();

            }

          }
        });

    }, delayMs);

  }
  private async renewConnection(): Promise<void> {

    // Never renew a connection during shutdown
    // or when no robots are using MQTT.
    if (
      this.shutdownComplete ||
    this.disconnectPromise ||
    this.activeRobots.size === 0
    ) {
      return;
    }

    const authentication = this.authentication;

    if (!authentication) {
      throw new Error(
        'Roomba MQTT authentication is unavailable for renewal.',
      );
    }

    this.log.info(
      'Renewing shared Roomba MQTT authentication...',
    );

    // Authenticate once for the entire iRobot account.
    const session = await authentication.authenticate();

    // Wait for any existing connection attempt to finish
    // before replacing the shared MQTT client.
    if (this.connectPromise) {
      try {
        await this.connectPromise;
      } catch {
        // A failed connection will be replaced
        // using the newly authenticated session.
      }
    }

    // A robot may have been released while waiting.
    if (
      this.shutdownComplete ||
  this.disconnectPromise ||
  this.activeRobots.size === 0
    ) {
      return;
    }

    // Authentication is asynchronous. Shutdown may have
    // started while fresh credentials were being obtained.
    if (
      this.shutdownComplete ||
  this.disconnectPromise ||
  this.activeRobots.size === 0
    ) {
      this.log.info(
        'Roomba MQTT renewal cancelled because the connection is shutting down.',
      );

      return;
    }

    // Stop the previous connection before creating another.
    const previousClient = this.mqttClient;

    this.mqttClient = undefined;

    if (previousClient) {
      await previousClient.disconnect();
    }

    // Apply fresh credentials to the shared manager.
    this.updateSession(session);

    // Establish exactly one replacement MQTT connection.
    // If this fails, leave the manager ready for the
    // scheduler's next authentication attempt.
    try {

      await this.openConnection();

    } catch (error) {

      this.mqttClient = undefined;

      this.log.warn(
        'Roomba MQTT renewal connection failed. ' +
    'A fresh authentication attempt will follow.',
      );

      throw error;

    }

    const mqttClient = this.mqttClient;

    if (!mqttClient) {
      throw new Error(
        'Renewed Roomba MQTT connection is unavailable.',
      );
    }

    // Restore both robots using the shared connection.
    await this.restoreSubscriptions(mqttClient);

    this.log.info(
      'Shared Roomba MQTT authentication renewed successfully.',
    );

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
    // Restore subscriptions for every active robot
    // whenever AWS IoT reconnects.
    mqttClient.onReconnect(() => {

      if (this.restorePromise) {
        return;
      }

      const restoration =
    this.restoreSubscriptions(mqttClient);

      this.restorePromise = restoration;

      void restoration
        .catch((error) => {
          this.log.error(
            `Roomba MQTT subscription restoration failed: ${String(error)}`,
          );
        })
        .finally(() => {
          if (this.restorePromise === restoration) {
            this.restorePromise = undefined;
          }
        });
    });
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
  private async restoreSubscriptions(
    mqttClient: V4MqttClient,
  ): Promise<void> {

    for (const robotBlid of this.activeRobots) {

      await mqttClient.subscribeToRobotState(
        robotBlid,
      );

      await mqttClient.requestShadow(
        robotBlid,
      );
    }
  }
}
