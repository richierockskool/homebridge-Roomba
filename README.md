# homebridge-roomba-pro

[![npm version](https://img.shields.io/npm/v/homebridge-roomba-pro.svg)](https://www.npmjs.com/package/homebridge-roomba-pro)
[![npm downloads](https://img.shields.io/npm/dt/homebridge-roomba-pro.svg)](https://www.npmjs.com/package/homebridge-roomba-pro)
[![Homebridge](https://img.shields.io/badge/Homebridge-Plugin-purple.svg)](https://homebridge.io)

**Modern iRobot Roomba support for Homebridge and Apple HomeKit, featuring Smart Map room cleaning and live robot status.**

**homebridge-roomba-pro** brings newer iRobot Roomba models into Apple Home through iRobot's V4 cloud platform and AWS IoT MQTT communication.

Control your Roomba, clean individual mapped rooms, monitor battery levels, and send your robot back to its dock — all from Apple Home.

## Features

- 🧹 Start and stop cleaning directly from Apple Home
- 🚪 Clean individual rooms using iRobot Smart Maps
- 🗺️ Automatically discover available mapped rooms
- 🏠 Send your Roomba back to its charging dock
- 🔋 Live battery percentage
- ⚡ Charging status
- 🅿️ Docked status
- 📡 Live robot updates through AWS IoT MQTT
- 🤖 Multiple Roomba support
- 🏡 Apple Home scenes and automations
- 🔄 Automatic synchronization between Roomba and HomeKit
- 🎛️ Independent HomeKit switches for cleaning, docking, and individual rooms

## Why Roomba Pro?

Many existing Homebridge Roomba plugins were originally designed for older iRobot models that communicate through local network protocols.

Newer Roomba generations use iRobot's cloud infrastructure and AWS IoT MQTT communication.

**homebridge-roomba-pro** is designed for these newer robots, providing an interface between the iRobot cloud platform and Apple HomeKit.

The goal is simple: make your Roomba feel like a native part of your Apple smart home.

## HomeKit Controls

Each discovered Roomba can expose the following controls:

| Control | Function |
|---|---|
| Cleaning | Start or stop a general cleaning job |
| Return to Dock | Send the robot back to its charging dock |
| Battery | Display current battery percentage and charging status |
| Smart Map Rooms | Start cleaning a selected room |
| Live Status | Update HomeKit as the robot's state changes |

### Individual Robot Controls

For example, a Roomba named **Big Bob** may appear with:

- Big Bob Cleaning
- Big Bob Return to Dock
- Big Bob Battery

A second Roomba named **Little Bob** may appear with:

- Little Bob Cleaning
- Little Bob Return to Dock
- Little Bob Battery

Robot names are intended to come from the iRobot account's discovered robot information rather than requiring users to hardcode their robot names.

Apple Home may retain previously customized accessory names.

## Smart Map Room Cleaning

One of the main features of Roomba Pro is support for **individual room cleaning**.

For compatible robots, the plugin discovers room information from the robot's existing iRobot Smart Map.

Rooms can appear in Apple Home as individual switches.

For example:

- Kitchen
- Living Room
- Dining Room
- Hallway
- Bedroom
- Storage Room

To clean a specific room, simply turn on its switch in Apple Home.

**Kitchen → ON**

The plugin sends a targeted room-cleaning command to the Roomba rather than starting a general cleaning job.

### Automatic Room Switch Updates

Room switches are designed to reflect the cleaning operation:

1. Turn ON the desired room switch.
2. The Roomba receives the targeted cleaning command.
3. The selected room switch remains ON while the cleaning job is active.
4. When the cleaning operation finishes, the room switch returns to OFF.

The general Cleaning switch also reflects the robot's cleaning status.

This behaviour has been tested with two Roomba robots.

### Important Notes

- The Roomba must already have a compatible Smart Map configured in the iRobot app.
- Available rooms depend on the robot's map information.
- Room cleaning requires support for targeted cleaning commands.
- Siri may occasionally interpret a room name as an Apple Home room rather than a cleaning command. In these cases, use the room switch directly in Apple Home.

## Multiple Roomba Support

Roomba Pro is designed to work with multiple robots associated with an iRobot account.

Each robot should have its own:

- Cleaning control
- Return to Dock control
- Battery information
- Available Smart Map room switches
- Individual robot state

### Current Testing

Multi-robot operation has been successfully tested with two Roombas.

Support for accounts containing three or more robots is intended but has not yet been fully validated.

Additional testing and user feedback are welcome.

## Requirements

- Homebridge
- A Node.js version supported by your Homebridge installation
- An iRobot account
- A compatible iRobot Roomba
- Internet access for iRobot cloud communication
- Apple Home / HomeKit

The plugin requires access to iRobot's cloud services to communicate with supported V4 robots.

## Installation

### Homebridge UI

Open the Homebridge web interface.

Navigate to:

**Plugins → Search**

Search for:

**homebridge-roomba-pro**

Install the plugin and follow the configuration instructions.

### Command Line

```bash
npm install -g homebridge-roomba-pro
```

Restart Homebridge after installation.

## Configuration

Open:

**Homebridge → Plugins → Roomba Pro → Settings**

Enter the required iRobot account information and save the configuration.

Restart Homebridge after making changes.

The plugin connects to the iRobot cloud platform and discovers compatible robot information.

For robots that support Smart Map room discovery, available room accessories are created from the robot's map information.

## How It Works

Roomba Pro communicates with newer iRobot robots using the iRobot V4 cloud architecture.

The plugin establishes an AWS IoT MQTT connection to receive robot information