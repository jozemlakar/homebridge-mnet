import type { API } from 'homebridge';
import { MnetPlatform, PLATFORM_NAME, PLUGIN_NAME } from './MnetPlatform.js';

export default (api: API): void => {
  api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, MnetPlatform);
};

export { MnetPlatform, PLATFORM_NAME, PLUGIN_NAME };
