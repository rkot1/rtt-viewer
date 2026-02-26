# RTT Viewer

A cross-platform desktop application for viewing SEGGER RTT (Real-Time Transfer) logs from embedded devices. Built with [Tauri](https://tauri.app/) and [probe-rs](https://probe-rs.github.io/probe-rs/).

RTT Viewer connects to ARM-based microcontrollers via debug probes (J-Link, ST-Link, CMSIS-DAP, etc.) and streams structured log output in real time — no UART needed.

## Features

- **Real-time RTT log streaming** — connect to any probe-rs supported debug probe and read RTT channels with minimal latency
- **Structured log parsing** — automatically parses Zephyr RTOS log format (`[HH:MM:SS.mmm] <level> tag: message`) with level and tag extraction
- **Auto-reconnect** — gracefully handles disconnections and reconnects when the target resets or the probe is re-plugged
- **Multi-core support** — select which core to attach to (e.g. app core vs net core on nRF5340)
- **ELF symbol extraction** — load an ELF file to automatically detect the `_SEGGER_RTT` address and chip variant
- **Chip auto-detection** — identifies Nordic (nRF52, nRF53, nRF91), STM32, and other ARM targets from ELF metadata
- **Connection profiles** — save and manage named profiles per target (chip, RTT address, ELF path, core index)
- **Log import/export** — import existing logs or export captured sessions as JSON, CSV, or plain text
- **Mock mode** — built-in simulated log stream for UI development and demos without hardware
- **Cross-platform** — runs on Windows, macOS, and Linux

## Supported Hardware

Any target supported by [probe-rs](https://probe-rs.github.io/probe-rs/), including:

- **Nordic Semiconductor** — nRF52832, nRF52833, nRF52840, nRF5340, nRF9160, nRF9151, nRF9161
- **STMicroelectronics** — STM32 family
- **Debug probes** — J-Link, ST-Link, CMSIS-DAP, and other probe-rs compatible adapters

## Getting Started

### Prerequisites

- [Rust](https://rustup.rs/) (stable)
- [Node.js](https://nodejs.org/) (v18+)
- Platform-specific dependencies (see [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/))

#### Linux (Ubuntu/Debian)

```bash
sudo apt-get install libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf libudev-dev
```

### Build & Run

```bash
# Install frontend dependencies
npm install

# Run in development mode
npm run tauri dev

# Build for production
npm run tauri build
```

## Usage

1. **Connect a debug probe** to your target device
2. **Select or create a profile** with your chip name (e.g. `nRF5340_xxAA`) and optionally load an ELF to auto-detect the RTT address
3. **Click Connect** — the app will find the probe, attach to the target, locate the RTT control block, and start streaming logs
4. **Filter and browse** logs by level, tag, or terminal channel

### Profiles

Profiles store connection settings so you don't have to re-enter them each session:

| Field | Description | Example |
|-------|-------------|---------|
| Name | Profile label | `my-nrf5340-app` |
| Chip | probe-rs target name | `nRF5340_xxAA` |
| RTT Address | Hex address of `_SEGGER_RTT` (optional) | `0x20031010` |
| ELF Path | Path to firmware ELF for symbol lookup | `/path/to/zephyr.elf` |
| Core | Core index (0 = app, 1 = net on nRF5340) | `0` |

Profiles are stored in your OS config directory under `rtt-viewer/profiles.json`.

## Architecture

The backend is written in Rust and handles all probe communication via probe-rs. The frontend receives structured log entries over Tauri's event system (`rtt-log`, `rtt-connected`, `rtt-stopped`, `rtt-disconnected`). RTT reading runs on a dedicated OS thread with automatic reconnection logic.

## CI/CD

This project uses GitHub Actions to build release binaries for all platforms. See `.github/workflows/release.yml`. To create a release:

```bash
git tag v0.1.0
git push origin v0.1.0
```

This triggers builds for Windows, macOS (ARM + Intel), and Linux, and creates a draft GitHub Release with all binaries attached.

## License

MIT
Copyright (c) 2025 Konstantin Smirnov