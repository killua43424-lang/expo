#!/usr/bin/env bun

import spawnAsync from '@expo/spawn-async';
import * as fs from 'fs';
import os from 'os';
import path from 'path';

interface ScreenshotRequest {
  action: 'screenshot';
  accessibilityId: string;
  outputPath: string;
  captureMode?: 'visible' | 'full'; // 'visible' = only visible portion, 'full' = entire scrollable content
}

interface CoordinatesRequest {
  action: 'getCoordinates';
  accessibilityId: string;
}

interface ScreenshotResponse {
  success: boolean;
  bounds?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  error: string;
}

export function getDylibPath(): string {
  const frameworkName = 'IOSScreenshotFramework.framework';
  const frameworkPath = path.resolve(__dirname, 'bin', frameworkName);
  const binaryPath = path.join(frameworkPath, 'IOSScreenshotFramework');

  if (!fs.existsSync(binaryPath)) {
    throw new Error(
      `Dylib not found at ${binaryPath}. Please build it first by running: cd ${path.dirname(frameworkPath)} && ./scripts/build.sh`
    );
  }

  return binaryPath;
}

export class ScreenInspectorIOS {
  private readonly dylibPath: string;
  private requestPipePath = '/tmp/ios_screenshot_request';
  private responsePipePath = '/tmp/ios_screenshot_response';

  constructor() {
    this.dylibPath = getDylibPath();
  }

  async getCoordinates(accessibilityId: string): Promise<{
    x: number;
    y: number;
    width: number;
    height: number;
  }> {
    const request: CoordinatesRequest = {
      action: 'getCoordinates',
      accessibilityId,
    };

    try {
      console.log(`🔍 Getting coordinates for element: ${accessibilityId}`);

      await this.writeToNamedPipe(this.requestPipePath, JSON.stringify(request));
      console.log('✅ Request sent to pipe');

      const responseData = await this.readFromNamedPipe(this.responsePipePath);
      console.log(`📨 Response received: ${responseData}`);

      const response: ScreenshotResponse = JSON.parse(responseData);

      if (!response.success) {
        throw new Error(`Get coordinates failed: ${response.error}`);
      }

      if (!response.bounds) {
        throw new Error('No bounds returned in response');
      }

      console.log('✅ Coordinates retrieved successfully');
      return response.bounds;
    } catch (error: any) {
      console.error('❌ iOS get coordinates failed:', error.message);
      throw error;
    }
  }

  async takeViewShotByAccessibilityId({
    accessibilityId,
    outputPath,
    captureMode = 'full',
  }: {
    accessibilityId: string;
    outputPath: string;
    captureMode?: 'visible' | 'full';
  }): Promise<string> {
    await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });

    const request: ScreenshotRequest = {
      action: 'screenshot',
      accessibilityId,
      outputPath,
      captureMode,
    };

    try {
      console.log(`🔍 Capturing element: ${accessibilityId}`);
      console.log(`📤 Sending request: ${JSON.stringify(request)}`);

      // Write request to named pipe
      await this.writeToNamedPipe(this.requestPipePath, JSON.stringify(request));
      console.log('✅ Request sent to pipe');

      // Read response from named pipe
      console.log('📥 Waiting for response...');
      const responseData = await this.readFromNamedPipe(this.responsePipePath);
      console.log(`📨 Response received: ${responseData}`);

      const response: ScreenshotResponse = JSON.parse(responseData);

      if (!response.success) {
        throw new Error(`View shot failed: ${response.error}`);
      }

      return outputPath;
    } catch (error: any) {
      console.error('❌ iOS screenshot failed:', error.message);
      throw error;
    }
  }

  private async writeToNamedPipe(pipePath: string, data: string): Promise<void> {
    return new Promise((resolve, reject) => {
      // Open the FIFO for writing
      fs.open(pipePath, 'w', (err: any, fd: number) => {
        if (err) {
          reject(new Error(`Failed to open pipe ${pipePath}: ${err.message}`));
          return;
        }

        const buffer = Buffer.from(data, 'utf8');

        fs.write(fd, buffer, 0, buffer.length, null, (err: any, bytesWritten: number) => {
          fs.close(fd); // Always close the file descriptor

          if (err) {
            reject(new Error(`Failed to write to pipe ${pipePath}: ${err.message}`));
            return;
          }

          if (bytesWritten !== buffer.length) {
            reject(
              new Error(`Partial write to pipe ${pipePath}: ${bytesWritten}/${buffer.length} bytes`)
            );
            return;
          }

          resolve();
        });
      });
    });
  }

  private async readFromNamedPipe(pipePath: string): Promise<string> {
    return new Promise((resolve, reject) => {
      // Open the FIFO for reading
      fs.open(pipePath, 'r', (err: any, fd: number) => {
        if (err) {
          reject(new Error(`Failed to open pipe ${pipePath}: ${err.message}`));
          return;
        }

        const buffer = Buffer.alloc(4096);

        fs.read(fd, buffer, 0, buffer.length, null, (err: any, bytesRead: number) => {
          fs.close(fd); // Always close the file descriptor

          if (err) {
            reject(new Error(`Failed to read from pipe ${pipePath}: ${err.message}`));
            return;
          }

          if (bytesRead === 0) {
            reject(new Error(`No data read from pipe ${pipePath}`));
            return;
          }

          const data = buffer.subarray(0, bytesRead).toString('utf8');
          resolve(data);
        });
      });
    });
  }

  async startSimulatorAppWithDylib(
    deviceID: string,
    bundleId: string,
    launchTimeoutMs: number = 10000
  ): Promise<void> {
    const env = {
      ...process.env,
      SIMCTL_CHILD_DYLD_INSERT_LIBRARIES: this.dylibPath,
    };

    try {
      // Kill app first to ensure dylib is loaded on launch
      await spawnAsync('xcrun', ['simctl', 'terminate', deviceID, bundleId], {
        stdio: 'pipe', // Always pipe to avoid errors if app isn't running
      });
    } catch {
      // App might not be running, which is fine
    }

    try {
      await spawnAsync(`xcrun`, ['simctl', 'launch', deviceID, bundleId], {
        stdio: 'inherit',
        env,
      });

      // just wait a bit for the app to start
      await new Promise((resolve) => setTimeout(resolve, launchTimeoutMs));

      // Check if pipes exist
      const requestPipeExists = fs.existsSync(this.requestPipePath);
      const responsePipeExists = fs.existsSync(this.responsePipePath);

      console.log(`Request pipe exists: ${requestPipeExists} (${this.requestPipePath})`);
      console.log(`Response pipe exists: ${responsePipeExists} (${this.responsePipePath})`);
    } catch (error: any) {
      console.warn('spawn with dylib failed', error.message);
    }
  }
}

// Example usage
if (require.main === module) {
  async function example() {
    const inspector = new ScreenInspectorIOS();

    try {
      await inspector.startSimulatorAppWithDylib('iPhone 17 Pro', 'dev.expo.Payments');

      // Get coordinates only
      const coords = await inspector.getCoordinates('image-comparison-list');
      console.log(
        `Element coordinates: x=${coords.x}, y=${coords.y}, width=${coords.width}, height=${coords.height}`
      );

      // Take screenshot - full scrollable content (default)
      const outputPath = path.join(os.tmpdir(), 'ios-element-screenshot-full.png');
      await inspector.takeViewShotByAccessibilityId({
        accessibilityId: 'image-comparison-list',
        outputPath,
        captureMode: 'full', // Captures entire scrollable content
      });
      console.log(`Screenshot saved to: ${outputPath}`);

      // Take viewshot - visible portion only
      const outputPathVisible = path.join(os.tmpdir(), 'ios-element-viewshot-visible.png');
      await inspector.takeViewShotByAccessibilityId({
        accessibilityId: 'image-comparison-list',
        outputPath: outputPathVisible,
        captureMode: 'visible', // Captures only visible portion
      });

      console.log(`View shot saved to: ${outputPathVisible}`);
    } catch (error) {
      console.error('Error:', error);
    }
  }

  example();
}
