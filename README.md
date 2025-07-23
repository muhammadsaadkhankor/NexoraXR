# Dtalk

## Overview
Dtalk is an interactive avatar system that combines 3D animation, speech synthesis, and natural language processing to create a responsive digital character.

## Step 1: Creating Avatar
To create a humanoid avatar and most importantly a professor-like avatar, we use Avaturn [avaturn.me](https://avaturn.me).

### Steps to create an avatar using Avaturn:
1. First, we uploaded three photos of the face (front, left, and right side).
2. After uploading the photos, we scrolled down and selected the body type (Male/Female).
3. We chose avatar type V2 (from the options V1 and V2), as V2 has an animatable face, which is essential.
4. Click on download to download the avatar in `.glb` format.

## Step 2: Adding Body Animations
To animate the avatar, follow these steps since avatars from different sources (e.g., Avaturn, Ready Player Me) have different skeletons.

### Steps to animate the avatar:
1. We converted the downloaded avatar to FBX format using Blender.
2. We uploaded the FBX avatar to [Mixamo](https://www.mixamo.com), which supports the FBX format, to download various animations (e.g., talking with hands, angry, surprised, etc.). 
3. Each animation was downloaded individually as a skeleton animation.
4. We used Blender again to group all these animations into a single file, which we saved as `animations.glb`.

## Step 3: Frontend for Avatar Animations
1. Loads a 3D model and applies changes to dynamically render all meshes such as dress, glasses, caps, etc. 
2. Animates the avatar's face and body based on user input and predefined expressions.
3. Maps speech sounds (visemes) to corresponding facial movements for lip-syncing.
4. Defines facial expressions (e.g., smile, angry, sad) using different facial morph targets.
5. Uses morph targets to control facial features like eye movement, mouth shapes, and jaw position.
6. Displays a chat interface where users can interact with the avatar through text or speech.

## Step 4: Backend for Generating Responses
1. A basic Express server is set up with `cors` for cross-origin requests. 
2. **Voice API Integration:** Uses ElevenLabs API for text-to-speech (TTS) conversion. It converts text input to speech audio files, handling voice stability and speaker boost.
3. **Speech-to-Text (STS):** Utilizes Whisper, a speech recognition model, to convert audio data into text. It processes audio by converting it to MP3 before transcription.
4. **Default Messages:** If no user input is provided or there are issues (e.g., missing API keys), the system returns pre-set default messages with audio, lip-sync, and facial expressions.
5. **Lip Sync Functionality:** The system generates phonemes from the speech audio using Rhubarb Lip Sync. These phonemes are then used for synchronizing the avatar's lip movements with the generated speech.
6. **OpenAI for Text Responses:** It uses OpenAI's language model to generate responses based on user questions. The responses include text, facial expressions, and animations for the avatar.
7. **File Handling:** Handles reading and converting audio files into base64 format, executing command-line operations like audio conversion, and reading JSON files for lip-sync data.

## About the .env File
The `.env` file is used to store API keys and configuration variables required for this project. It contains sensitive information that should not be shared publicly. The `.env` file includes:

- **API Keys:** Keys for services like ElevenLabs (TTS), Whisper (speech recognition), and OpenAI (text generation).
- **Environment Variables:** Variables to configure server settings, such as `PORT` and other options.

An example `.env` file (`env.template.txt`) is provided in the repository. During setup, this template should be copied and renamed to `.env` to ensure the APIs function properly.

## Prerequisites
1. First ensure Git is installed on your system, if not you can install it from the link below:
   - [Git for Windows](https://git-scm.com/downloads/win)
   - For Linux: `sudo apt-get install git` (Ubuntu/Debian) or `sudo yum install git` (CentOS/RHEL)

2. For Docker method:
   - Docker and Docker Compose installed and running on your machine
   - [Download Docker](https://www.docker.com/products/docker-desktop/)

## Installation Instructions

There are two ways to install and run this project:

### Method 1: Without Docker

If you prefer to run the application without Docker, follow these steps:

1. Open your terminal inside any directory you want to clone "dtalk" repository.
   ```bash
   git clone https://msaad007@bitbucket.org/inspiratio/dtalk.git
   ```
🔐 When cloning in Ubuntu or WSL, Bitbucket will prompt you for a password. Please use the following:
ATBBfqwjpXcfWSahpgRkyYN9KU8d25BCF6E6
```bash
cd dtalk
```
2. Backend Setup:

   Linux
      ```bash
      # Extract the bin file
      unzip backend/bin.zip -d backend/bin
      
      # Set up the .env file
      cp backend/env.template.txt backend/.env
      ```
   Window
      ```bash
      # Extract the bin file
      mkdir backend\bin
      tar -xf backend\bin.zip -C backend\bin
      
      # Set up the .env file
      copy backend\env.template.txt backend\.env
      ```

4. Then we need to install the dependencies
   ```bash 
   yarn install
   ```
    
5. Start the Development Servers:
   ```bash
   yarn dev
   ```
### Method 2: Using Docker (Recommended)

We recommend using Docker as it ensures consistent behavior across different systems and eliminates compatibility issues.

#### Steps:

1. Clone the Repository
```bash
   git clone https://msaad007@bitbucket.org/inspiratio/dtalk.git
```
🔐 When cloning in Ubuntu or WSL, Bitbucket will prompt you for a password. Please use the following:
ATBBfqwjpXcfWSahpgRkyYN9KU8d25BCF6E6
```bash
cd dtalk
```

2. Backend Setup:

   Linux
      ```bash
      # Extract the bin file
      unzip backend/bin.zip -d backend/bin
      
      # Set up the .env file
      cp backend/env.template.txt backend/.env
      ```
   Window
      ```bash
      # Extract the bin file
      mkdir backend\bin
      tar -xf backend\bin.zip -C backend\bin
      
      # Set up the .env file
      copy backend\env.template.txt backend\.env
      ```
   
3. Edit the `.env` file with your API keys
   ```bash
   # Open the file in your favorite editor
   nano backend/.env
   
   # Add your API keys
   OPENAI_API_KEY=your_key_here
   ELEVEN_LABS_API_KEY=your_key_here
   ELEVEN_LABS_VOICE_ID=your_voice_id
   ELEVEN_LABS_MODEL_ID=eleven_multilingual_v1
   
   ```

4. Build and Run with Docker
   ```bash
   # Build the Docker containers
   docker-compose build
   
   # Run the application
   docker-compose up
   ```
   
5. Access the application
   - Frontend: http://localhost:5173
   - Backend: http://localhost:3000

6. To stop the application
   ```bash
   # Use Ctrl+C in the terminal or
   docker-compose down
   ```

## Updating the Project (Pull Latest Changes)

After the initial setup, if the Dtalk project receives updates (e.g., new features, bug fixes, or dependency changes), you don't need to repeat the entire installation process. Simply follow the steps below to stay up-to-date with the latest code:

### Without Docker

1. **Open your terminal in the directory of Dtalk which you previously cloned**

2. **Pull the Latest Changes from the Repository**
   ```bash
   # For main branch
   git pull origin main
   
   # For our own Llama model
   git pull origin llm
   ```

3. **Install New Dependencies (if any)**
   ```bash
   yarn install
   ```

4. **Start the Project**
   ```bash
   yarn dev
   ```

### With Docker

1. **Open your terminal in the directory of Dtalk which you previously cloned**

2. **Pull the Latest Changes from the Repository**
   ```bash
   # For main branch
   git pull origin main
   
   # For our own Llama model
   git pull origin llm
   ```

3. **Rebuild the Docker Images**
   ```bash
   docker-compose build
   ```

4. **Start or Restart the Containers**
   ```bash
   docker-compose up -d
   ```

## Docker Configuration Details

This project uses Docker Compose to run both the frontend and backend services:

- **Frontend Container**: Node.js 18 with Vite server
  - Port: 5173
  - Mounts source code as volume for hot reloading
  
- **Backend Container**: Node.js 18 with Express
  - Port: 3000
  - Includes FFmpeg for audio processing
  - Sets up Rhubarb lip sync binary
  - Connects to local LLaMA server (if used)

## Troubleshooting Docker Setup

If you encounter issues with Docker mounting permissions:

1. Check Docker file sharing settings
   ```bash
   # Fix directory permissions
   sudo chown -R $USER:$USER .
   sudo chmod -R 755 .
   ```

2. If accessing a local LLaMA server, ensure the `host.docker.internal` setting is properly configured in `.env` file

3. For connectivity issues between containers:
   ```bash
   # Check container status
   docker-compose ps
   
   # View container logs
   docker-compose logs
   ```

## Development Notes

- The system requires API keys for OpenAI and ElevenLabs to function properly
- For local development, ensure proper ports are available (3000, 5173)
- When modifying code in Docker development mode, changes are reflected immediately due to volume mounts