declare module 'plyr' {
  interface PlyrFullscreenController {
    toggle(): void
  }

  interface PlyrOptions {
    [key: string]: unknown
  }

  export default class Plyr {
    constructor(target: Element | string, options?: PlyrOptions)

    muted: boolean
    fullscreen: PlyrFullscreenController

    destroy(): void
    togglePlay(toggle?: boolean): Promise<void> | boolean | void
    rewind(seekTime?: number): void
    forward(seekTime?: number): void
    increaseVolume(step?: number): void
    decreaseVolume(step?: number): void
  }
}
