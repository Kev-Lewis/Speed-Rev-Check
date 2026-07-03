/* Minimal ambient types for mp4box.js — enough for the WebCodecs reader.
 * For fuller types, `npm i -D @types/mp4box` and delete this file. */
declare module "mp4box" {
  export interface MP4VideoTrack {
    id: number;
    codec: string;
    timescale: number;
    duration: number;
    nb_samples: number;
    video: { width: number; height: number };
  }
  export interface MP4Info {
    videoTracks: MP4VideoTrack[];
    duration: number;
    timescale: number;
  }
  export interface MP4Sample {
    cts: number;
    dts: number;
    duration: number;
    timescale: number;
    is_sync: boolean;
    data: ArrayBuffer;
  }
  export interface MP4File {
    onReady?: (info: MP4Info) => void;
    onError?: (e: string) => void;
    onSamples?: (id: number, user: unknown, samples: MP4Sample[]) => void;
    appendBuffer(data: ArrayBuffer & { fileStart: number }): number;
    flush(): void;
    start(): void;
    stop(): void;
    getTrackById(id: number): unknown;
    setExtractionOptions(id: number, user: unknown, opts: { nbSamples?: number }): void;
  }
  export function createFile(): MP4File;
  export class DataStream {
    constructor(buffer?: ArrayBuffer, byteOffset?: number, endianness?: boolean);
    static BIG_ENDIAN: boolean;
    buffer: ArrayBuffer;
  }
  const MP4Box: { createFile: typeof createFile; DataStream: typeof DataStream };
  export default MP4Box;
}
