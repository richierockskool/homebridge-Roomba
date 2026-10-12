import type { Logging } from 'homebridge';

export interface V4Credentials {
  email: string;
  password: string;
  countryCode: string;
}

export interface V4Deployment {
  httpBase: string;
  httpBaseAuth: string;
  mqttAts: string;
  irbtTopics: string;
  awsRegion: string;
}

export interface V4CloudCredentials {
  accessKeyId: string;
  secretKey: string;
  sessionToken: string;
  cognitoId: string;
  expiration?: string;
}

export interface V4Robot {
  blid: string;
  name: string;
  sku: string;
  softwareVer?: string;
}

export interface V4Session {
  deployment: V4Deployment;

  cloudCredentials: V4CloudCredentials;

  authenticatedAt: number;

  iotToken: string;
  iotSignature: string;
  iotAuthorizerName: string;
  iotClientId: string;

  robots: V4Robot[];
}
interface DiscoveryResult {
  deployment: V4Deployment;
  gigyaApiKey: string;
  gigyaDomain: string;
}


interface GigyaResult {
  uid: string;
  signature: string;
  timestamp: string;
}

interface UnknownObject {
  [key: string]: unknown;
}

/**
 * Current iRobot Prime Android application identifier.
 *
 * This value is used by iRobot's /v2/login request.
 * It is an application identifier, not a user secret.
 */
const APP_ID =
  'ANDROID-C7FB240E-DF34-42D7-AE4E-A8C17079A294';

const DISCOVERY_URL =
  'https://disc-prod.iot.irobotapi.com/v1/discover/endpoints';

/**
 * Handles the iRobot V4 authentication lifecycle.
 *
 * Security rule:
 * Never log passwords, UID signatures, IoT tokens,
 * IoT signatures or authentication headers.
 */
export class V4Authentication {

  constructor(
    private readonly log: Logging,
    private readonly credentials: V4Credentials,
  ) {
  }

  /**
   * Perform the full HTTPS authentication chain:
   *
   * 1. iRobot endpoint discovery
   * 2. Gigya authentication
   * 3. iRobot /v2/login
   *
   * MQTT connection is deliberately handled elsewhere.
   */
  public async authenticate(): Promise<V4Session> {

    this.validateCredentials();

    this.log.info(
      'Starting iRobot V4 authentication...',
    );

    const discovery =
      await this.discover();

    this.log.info(
      'iRobot V4 service discovery succeeded.',
    );

    const gigya =
      await this.gigyaLogin(
        discovery.gigyaApiKey,
        discovery.gigyaDomain,
      );

    this.log.info(
      'iRobot account authentication succeeded.',
    );

    const session =
      await this.accountLogin(
        discovery.deployment,
        gigya,
      );

    this.log.info(
      `iRobot V4 login succeeded. Found ${session.robots.length} robot(s).`,
    );

    for (const robot of session.robots) {
      this.log.info(
        `Roomba discovered: ${robot.name} (${robot.sku})`,
      );
    }

    return session;
  }

  public getCountryCode(): string {

    const countryCode =
      this.credentials.countryCode
        .trim()
        .toUpperCase();

    if (!/^[A-Z]{2}$/.test(countryCode)) {
      return 'CA';
    }

    return countryCode;
  }

  /**
   * Step 1:
   * Discover the active iRobot deployment and Gigya settings.
   */
  private async discover(): Promise<DiscoveryResult> {

    const url =
      new URL(DISCOVERY_URL);

    url.searchParams.set(
      'country_code',
      this.getCountryCode(),
    );

    const response =
      await this.fetchWithTimeout(
        url,
        {
          method: 'GET',
          headers: {
            Accept: 'application/json',
          },
        },
        15_000,
      );

    if (!response.ok) {
      throw new Error(
        `iRobot discovery failed with HTTP ${response.status}.`,
      );
    }

    const payload =
      await response.json() as UnknownObject;

    const currentDeployment =
      this.requireString(
        payload.current_deployment,
        'current_deployment',
      );

    const deployments =
      this.requireObject(
        payload.deployments,
        'deployments',
      );

    const deploymentObject =
      this.requireObject(
        deployments[currentDeployment],
        `deployments.${currentDeployment}`,
      );

    const gigya =
      this.requireObject(
        payload.gigya,
        'gigya',
      );

    const mqttAtsValue =
      deploymentObject.mqttAts ??
      deploymentObject.mqtt;

    return {
      deployment: {
        httpBase:
          this.requireString(
            deploymentObject.httpBase,
            'httpBase',
          ),
        httpBaseAuth:
  this.requireString(
    deploymentObject.httpBaseAuth,
    'httpBaseAuth',
  ),   

        mqttAts:
          this.requireString(
            mqttAtsValue,
            'mqttAts',
          ),

        irbtTopics:
          this.requireString(
            deploymentObject.irbtTopics,
            'irbtTopics',
          ),

        awsRegion:
          this.requireString(
            deploymentObject.awsRegion,
            'awsRegion',
          ),
      },

      gigyaApiKey:
        this.requireString(
          gigya.api_key,
          'gigya.api_key',
        ),

      gigyaDomain:
        this.requireString(
          gigya.datacenter_domain,
          'gigya.datacenter_domain',
        ),
    };
  }

  /**
   * Step 2:
   * Authenticate the iRobot account through Gigya.
   */
  private async gigyaLogin(
    apiKey: string,
    domain: string,
  ): Promise<GigyaResult> {

    const body =
      new URLSearchParams();

    body.set(
      'apiKey',
      apiKey,
    );

    body.set(
      'targetenv',
      'mobile',
    );

    body.set(
      'targetEnv',
      'mobile',
    );

    body.set(
      'loginID',
      this.credentials.email.trim(),
    );

    body.set(
      'password',
      this.credentials.password,
    );

    body.set(
      'format',
      'json',
    );

    const response =
      await this.fetchWithTimeout(
        new URL(
          `https://accounts.${domain}/accounts.login`,
        ),
        {
          method: 'POST',

          headers: {
            Accept: 'application/json',
            'Content-Type':
              'application/x-www-form-urlencoded',
          },

          body,
        },
        15_000,
      );

    if (!response.ok) {
      throw new Error(
        `iRobot account authentication failed with HTTP ${response.status}.`,
      );
    }

    const payload =
      await response.json() as UnknownObject;

   

    const statusCode =
      typeof payload.statusCode === 'number'
        ? payload.statusCode
        : undefined;

    if (statusCode !== 200) {

      const message =
        this.optionalString(
          payload.errorDetails,
        ) ??
        this.optionalString(
          payload.errorMessage,
        ) ??
        'Authentication failed.';

      throw new Error(
        `iRobot account authentication failed: ${message}`,
      );
    }

    return {
      uid:
        this.requireString(
          payload.UID,
          'UID',
        ),

      signature:
        this.requireString(
          payload.UIDSignature,
          'UIDSignature',
        ),

      timestamp:
        this.requireString(
          payload.signatureTimestamp,
          'signatureTimestamp',
        ),
    };
  }

  /**
   * Step 3:
   * Exchange the Gigya identity for the iRobot V4
   * IoT session and robot list.
   */
  private async accountLogin(
    deployment: V4Deployment,
    gigya: GigyaResult,
  ): Promise<V4Session> {

    const response =
      await this.fetchWithTimeout(
        new URL(
          `${deployment.httpBase}/v2/login`,
        ),
        {
          method: 'POST',

          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
          },

          body: JSON.stringify({
            app_id: APP_ID,

            assume_robot_ownership:
              '0',

            gigya: {
              signature:
                gigya.signature,

              timestamp:
                gigya.timestamp,

              uid:
                gigya.uid,
            },
          }),
        },
        20_000,
      );

    if (!response.ok) {
      throw new Error(
        `iRobot V4 login failed with HTTP ${response.status}.`,
      );
    }

    const payload =
      await response.json() as UnknownObject;

    const credentials =
  this.requireObject(
    payload.credentials,
    'credentials',
  );

    const robotsObject =
      this.requireObject(
        payload.robots,
        'robots',
      );

    const robots: V4Robot[] = [];

    for (
      const [blid, robotValue]
      of Object.entries(robotsObject)
    ) {

      const robot =
        this.requireObject(
          robotValue,
          `robots.${blid}`,
        );

      robots.push({
        blid,

        name:
          this.optionalString(
            robot.name,
          ) ?? 'Roomba',

        sku:
          this.optionalString(
            robot.sku,
          ) ?? 'Unknown',

        softwareVer:
          this.optionalString(
            robot.softwareVer,
          ),
      });
    }

    if (robots.length === 0) {
      throw new Error(
        'iRobot account contains no Roomba robots.',
      );
    }

    return {
      authenticatedAt: Date.now(),
      deployment,
      cloudCredentials: {
        accessKeyId:
    this.requireString(
      credentials.AccessKeyId,
      'credentials.AccessKeyId',
    ),

        secretKey:
    this.requireString(
      credentials.SecretKey,
      'credentials.SecretKey',
    ),

        sessionToken:
    this.requireString(
      credentials.SessionToken,
      'credentials.SessionToken',
    ),

        cognitoId:
    this.requireString(
      credentials.CognitoId,
      'credentials.CognitoId',
    ),

        expiration:
    this.optionalString(
      credentials.Expiration,
    ),
      },

      iotToken:
        this.requireString(
          payload.iot_token,
          'iot_token',
        ),

      iotSignature:
        this.requireString(
          payload.iot_signature,
          'iot_signature',
        ),

      iotAuthorizerName:
        this.requireString(
          payload.iot_authorizer_name,
          'iot_authorizer_name',
        ),

      iotClientId:
        this.requireString(
          payload.iot_clientid,
          'iot_clientid',
        ),

      robots,
    };
  }

  private validateCredentials(): void {

    if (
      !this.credentials.email
        .trim()
    ) {
      throw new Error(
        'iRobot account email is missing.',
      );
    }

    if (
      !this.credentials.password
    ) {
      throw new Error(
        'iRobot account password is missing.',
      );
    }
  }

  /**
   * Fetch helper with a hard timeout so Homebridge
   * can never hang indefinitely on an iRobot request.
   */
  private async fetchWithTimeout(
    url: URL,
    options: RequestInit,
    timeoutMilliseconds: number,
  ): Promise<Response> {

    const controller =
      new AbortController();

    const timeout =
      setTimeout(
        () => {
          controller.abort();
        },
        timeoutMilliseconds,
      );

    try {

      return await fetch(
        url,
        {
          ...options,
          signal: controller.signal,
        },
      );

    } catch (error) {

      if (
        error instanceof Error &&
  error.name === 'AbortError'
      ) {
        throw new Error(
          `iRobot request timed out after ${timeoutMilliseconds / 1000} seconds.`,
          {
            cause: error,
          },
        );
      }

      throw error;

    } finally {

      clearTimeout(timeout);
    }
  }

  private requireObject(
    value: unknown,
    fieldName: string,
  ): UnknownObject {

    if (
      typeof value !== 'object' ||
      value === null ||
      Array.isArray(value)
    ) {
      throw new Error(
        `iRobot response is missing ${fieldName}.`,
      );
    }

    return value as UnknownObject;
  }

  private requireString(
    value: unknown,
    fieldName: string,
  ): string {

    if (
      typeof value !== 'string' ||
      value.length === 0
    ) {
      throw new Error(
        `iRobot response is missing ${fieldName}.`,
      );
    }

    return value;
  }

  private optionalString(
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
}