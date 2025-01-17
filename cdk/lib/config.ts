import * as dotenv from 'dotenv';
import * as path from 'path';
import { MinecraftImageEnv, MinecraftServerDefs, StackConfig } from './types';
import { stringAsBoolean } from './util';

dotenv.config({ path: path.resolve(__dirname, '../.env') });

const resolveMinecraftServerDefs = (json = ''): MinecraftServerDefs => {
  const defaults = {};
  try {
    return {
      ...defaults,
      ...JSON.parse(json),
    };
  } catch (e) {
    console.error(
      'Error: Unable to resolve .env value for MINECRAFT_SERVER_DEFS_JSON.'
    );
    return defaults;
  }
};

export const resolveConfig = (): StackConfig => ({
  domainName: process.env.DOMAIN_NAME || '',
  serverRegion: process.env.SERVER_REGION || 'us-east-1',
  minecraftEdition:
    process.env.MINECRAFT_EDITION === 'bedrock' ? 'bedrock' : 'java',
  shutdownMinutes: process.env.SHUTDOWN_MINUTES || '20',
  startupMinutes: process.env.STARTUP_MINUTES || '10',
  useFargateSpot: stringAsBoolean(process.env.USE_FARGATE_SPOT) || false,
  taskCpu: +(process.env.TASK_CPU || 1024),
  taskMemory: +(process.env.TASK_MEMORY || 2048),
  vpcId: process.env.VPC_ID || '',
  snsEmailAddress: process.env.SNS_EMAIL_ADDRESS || '',
  twilio: {
    phoneFrom: process.env.TWILIO_PHONE_FROM || '',
    phoneTo: process.env.TWILIO_PHONE_TO || '',
    accountId: process.env.TWILIO_ACCOUNT_ID || '',
    authCode: process.env.TWILIO_AUTH_CODE || '',
  },
  debug: stringAsBoolean(process.env.DEBUG) || false,
  minecraftServerDefs: resolveMinecraftServerDefs(
    process.env.MINECRAFT_SERVER_DEFS_JSON
  ),
});
