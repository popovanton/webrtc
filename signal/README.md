# WebRTC Signaling Server

A simple WebRTC signaling server built with Node.js, Express, and Socket.IO.

## Features

- Real-time signaling using WebSocket
- User registration and management
- Simple test client interface
- Support for multiple concurrent connections

## Installation

1. Make sure you have Node.js installed on your system
2. Clone this repository
3. Install dependencies:
```bash
npm install
```

## Usage

1. Start the server:
```bash
npm start
```

2. Open your browser and navigate to `http://localhost:3000`

3. Enter a username and click "Connect"

4. You can test the signaling by:
   - Opening multiple browser windows
   - Connecting with different usernames
   - Clicking on a user in the list to send a test signal

## How it Works

The server acts as a signaling intermediary for WebRTC connections. It:

1. Maintains a list of connected users
2. Forwards signaling messages between peers
3. Handles user registration and disconnection
4. Provides a simple web interface for testing

## API

The server uses Socket.IO for real-time communication with the following events:

- `register`: Register a new user
- `signal`: Send signaling data to another user
- `userList`: Receive updated list of connected users

## License

MIT 