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

### 1. Git Installation
First ensure Git is installed on your system:

**Windows:**
- Download and install from [Git for Windows](https://git-scm.com/downloads/win)

**Linux:**
```bash
# Ubuntu/Debian
sudo apt-get install git

# CentOS/RHEL
sudo yum install git
```

### 2. Docker Installation

#### For Windows:
1. Visit [Docker's official website](https://www.docker.com/)
2. Download Docker Desktop for Windows
3. Run the installer and follow the setup instructions
4. Restart your computer if prompted #optional
5. open docker-desktop
#### For Linux (Ubuntu/Debian):

**Step 1: Update the system**
```bash
sudo apt update 
sudo apt upgrade -y
```

**Step 2: Install required dependencies**
```bash
sudo apt install -y ca-certificates curl gnupg lsb-release
```

**Step 3: Add Docker's official GPG key**
```bash
sudo mkdir -p /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | \
sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
```

**Step 4: Set up the Docker repository**
```bash
echo \
"deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable" | \
sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
```

**Step 5: Install Docker Engine**
```bash
sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
```

**Step 6: Verify Docker installation**
```bash
docker --version
```

**Step 7: Start Docker service**
```bash
sudo systemctl start docker
sudo systemctl enable docker
```

## Dtalk Installation

We recommend using Docker as it ensures consistent behavior across different systems and eliminates compatibility issues.

### Steps:

**1. Clone the Repository**
```bash
git clone https://msaad007@bitbucket.org/inspiratio/dtalk.git
```

> 🔐 **Authentication Note:** When cloning in Ubuntu or WSL, Bitbucket will prompt you for a password. Please use: `ATBBfqwjpXcfWSahpgRkyYN9KU8d25BCF6E6`

```bash
cd dtalk
```
**For Linux/macOS:**
```bash
# Extract the bin file
unzip backend/bin.zip -d backend/bin

# Set execute permissions for the rhubarb file
cd backend/bin
chmod +x rhubarb

# Return to the project root and set up the .env file
cd ../..
cp backend/env.template.txt backend/.env
```
**For Windows:**
```bash
# Extract the bin file
mkdir backend\bin
tar -xf backend\bin.zip -C backend\bin

# Set up the .env file
copy backend\env.template.txt backend\.env
```

**3. Configure API Keys
Edit the .env file with your API keys:
For Linux/macOS:
Since files starting with "." are hidden by default in the file manager, use a text editor from the terminal:
bash# Open the .env file in nano editor
nano backend/.env

# Alternative: use other text editors
# vim backend/.env
# code backend/.env  (VS Code)

For Windows:
You can edit the file directly through File Explorer or use a text editor:

Navigate to the backend folder and open .env with any text editor
Or use Command Prompt: notepad backend\.env

Add your API keys to the file:
OPENAI_API_KEY=your_actual_openai_key_here
ELEVEN_LABS_API_KEY=your_actual_elevenlabs_key_here
ELEVEN_LABS_VOICE_ID=your_voice_id_here
ELEVEN_LABS_MODEL_ID=eleven_multilingual_v1

Example with real values:
envOPENAI_API_KEY=sk-1234567890abcdef...
ELEVEN_LABS_API_KEY=a1b2c3d4e5f6...
ELEVEN_LABS_VOICE_ID=21m00Tcm4TlvDq8ikWAM
ELEVEN_LABS_MODEL_ID=eleven_multilingual_v1
Saving the file:

In nano: Press Ctrl + S to save, then Ctrl + X to exit
In other editors: Use Ctrl + S (or Cmd + S on macOS) to save

Important Notes:
Replace the placeholder values with your actual API keys
Keep your API keys secure and never share them publicly
Make sure there are no extra spaces around the = sign

**4. Build and Run with Docker**
```bash
# Build the Docker containers
docker-compose build

# Run the application
docker-compose up -d
```

**5. Access the Application**
- **Frontend:** http://localhost:5173
- **Backend:** http://localhost:3000

**6. Stop the Application**
```bash
# Use Ctrl+C in the terminal or run:
docker-compose down
```

## Updating the Project (Pull Latest Changes)

After the initial setup, if the Dtalk project receives updates (e.g., new features, bug fixes, or dependency changes), you don't need to repeat the entire installation process. Simply follow the steps below to stay up-to-date with the latest code:

1. **Navigate to your Dtalk directory**
```bash
cd path/to/dtalk
```
2. **Pull the latest changes from the repository**
```bash
# For main branch
git pull origin main

# For our own Llama model
git pull origin llm
```

3. **Rebuild the Docker images**
```bash
docker-compose build
```

4. **Start or restart the containers**
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

If you encounter issues with Docker setup:

**1. Permission Issues:**
```bash
# Fix directory permissions
sudo chown -R $USER:$USER .
sudo chmod -R 755 .
```

**2. Local LLaMA Server Connection:**
- Ensure the `host.docker.internal` setting is properly configured in `.env` file

**3. Container Connectivity Issues:**
```bash
# Check container status
docker-compose ps

# View container logs
docker-compose logs

# View logs for specific service
docker-compose logs frontend
docker-compose logs backend
```

**4. Port Conflicts:**
- Ensure ports 3000 and 5173 are not being used by other applications
- You can check with: `netstat -tulpn | grep :3000` or `netstat -tulpn | grep :5173`

**5. Docker Service Issues (Linux):**
```bash
# Restart Docker service
sudo systemctl restart docker

# Check Docker service status
sudo systemctl status docker
```

## Development Notes

- The system requires API keys for OpenAI and ElevenLabs to function properly
- For local development, ensure proper ports are available (3000, 5173)
- When modifying code in Docker development mode, changes are reflected immediately due to volume mounts
- If you encounter any issues with Docker commands requiring sudo, make sure your user is added to the Docker group