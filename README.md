# homebridge-roomba-pro

[![npm version](https://img.shields.io/npm/v/homebridge-roomba-pro.svg)](https://www.npmjs.com/package/homebridge-roomba-pro)
[![npm downloads](https://img.shields.io/npm/dt/homebridge-roomba-pro.svg)](https://www.npmjs.com/package/homebridge-roomba-pro)
[![Homebridge](https://img.shields.io/badge/Homebridge-Plugin-purple.svg)](https://homebridge.io)

Modern iRobot Roomba support for Homebridge and Apple HomeKit.

**homebridge-roomba-pro** brings newer iRobot Roomba models into Apple HomeKit, including robots using iRobot's newer V4 cloud platform.

Control your Roomba directly from the Apple Home app and use it in HomeKit scenes and automations.

## Features

- 🧹 Start and stop cleaning from Apple Home
- 🏠 Send the Roomba home to its dock
- 🔋 Live battery level
- ⚡ Charging status
- 🅿️ Docked status
- 🧭 Live robot state updates
- 📡 iRobot V4 cloud / AWS IoT MQTT communication
- 🚪 Room-specific cleaning controls
- 🏡 HomeKit scenes and automations
- 🔄 Automatic state synchronization with the robot

## Why Roomba Pro?

Many existing Homebridge Roomba plugins were designed around older generations of
iRobot's local communication protocol.

Newer Roomba models use iRobot's cloud infrastructure and AWS IoT MQTT for
communication.

**homebridge-roomba-pro** is designed specifically to support these newer robots
while presenting them as native accessories inside Apple Home.

## HomeKit Controls

Depending on the capabilities reported by your Roomba, HomeKit can expose:

| Control | Function |
|---|---|
| Cleaning | Start or stop a cleaning job |
| Dock | Send the Roomba back to its dock |
| Battery | Current battery percentage |
| Charging | Shows when the robot is charging |
| Docked | Shows when the robot is on its dock |
| Rooms | Start cleaning of an individual room |

Room controls allow commands such as:

**Kitchen → ON**

to start a cleaning job targeted specifically at the Kitchen.

## Requirements

- Homebridge
- Node.js supported by your Homebridge installation
- An iRobot account
- A compatible Roomba
- Internet access for iRobot cloud communication
- Apple Home / HomeKit

## Installation

Install through the Homebridge UI by searching for:

**Roomba Pro**

or install from the command line:

    npm install -g homebridge-roomba-pro

Then restart Homebridge.

## Configuration

Open:

**Homebridge → Plugins → Roomba Pro → Settings**

Enter your iRobot account credentials and save the configuration.

Restart Homebridge after making configuration changes.

## How It Works

Roomba Pro connects to iRobot's cloud service and establishes a live MQTT
connection to the robot through AWS IoT.

Robot state messages are translated into HomeKit characteristics so changes such
as cleaning, docking, charging and battery level are reflected automatically in
Apple Home.

Commands sent from Apple Home are translated back into the appropriate iRobot
commands.

## Room Cleaning

Compatible robots can expose their mapped rooms as individual HomeKit controls.

For example:

- Kitchen
- Living Room
- Dining Room
- Hallway
- Bedroom

Turning on a room accessory tells the Roomba to clean that specific room.

Room availability depends on the maps and room information available from the
robot.

## Troubleshooting

If the robot does not respond, first check the Homebridge log.

Useful Roomba Pro log entries include connection, authentication, MQTT,
command and robot-state information.

When reporting a problem, please include:

1. Roomba model
2. Homebridge version
3. Node.js version
4. Roomba Pro version
5. Relevant Homebridge log entries

**Do not post passwords, authentication tokens or other iRobot credentials.**

## Supported Robots

Roomba Pro is primarily being developed for newer iRobot robots using the
current iRobot cloud/V4 architecture.

Additional models will be documented as they are tested and confirmed.

If your model works, please consider reporting it so it can be added to the
compatibility list.

## Development Status

Roomba Pro is under active development.

Support for additional Roomba capabilities and models will continue to be added
as they are tested.

## Issues and Contributions

Bug reports, testing results and contributions are welcome.

When opening an issue, include the Roomba model and relevant Homebridge logs
whenever possible.

## Disclaimer

This project is an independent Homebridge plugin and is not affiliated with,
endorsed by, or sponsored by iRobot Corporation or Apple Inc.

Roomba and iRobot are trademarks of iRobot Corporation.

Apple, HomeKit and Apple Home are trademarks of Apple Inc.

## License

MIT
