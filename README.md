# Dtalk

## Overview
Digital Being is an interactive avatar system that combines 3D animation, speech synthesis, and natural language processing to create a responsive digital character.

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

## prerequisite
1. First ensure git installed on your system, if not you can install it from the link below: \\
[git for windows](https://git-scm.com/downloads/win)

## Installation Instructions
There are two ways to install and run this project:
### Method 1: Without Docker
If you prefer to run the application without Docker, follow these steps:
1. Open you terminal anywhere in your pc (any directory).
    - Than clone your repository by copying command from bitbucket interface
    - After cloning finished type command:
    ```    cd dtalk
    ```
    - this will take you to repository.

2. Install Frontend Dependencies:
    ```
    cd frontend
    yarn install
    ```

3. Install Backend Dependencies:
    Before installing the backend, perform the following steps:
    - Extract the `bin.zip` file using a command:
      ```
      unzip bin.zip -d bin
      ```
      Alternatively, use any zip extractor like WinRAR or file explorer.
    - Create the `.env` file from the template:
      ```
      cp env.template.txt .env
      ```

    Then, install backend dependencies:
    ```
    cd ../backend
    yarn install
    ```

4. Start the Development Servers:

    For Frontend:
    ```
    cd frontend
    yarn run dev
    ```

    For Backend (in a new terminal):
    ```
    cd backend
    yarn run dev
    ```

---

### Method 2: Using Docker (Recommended)

We recommend using Docker as it ensures consistent behavior across different systems and eliminates compatibility issues.

#### Prerequisites:
- Docker and Docker Compose installed and running on your machine
- [Download Docker](https://www.docker.com/products/docker-desktop/)

#### Steps:

1. Clone the repository:
    ```
    git clone https://msaad007@bitbucket.org/inspiratio/dtalk.git
    cd dtalk
    ```

2. Prepare the `.env` file:
    Before building the Docker containers, create the `.env` file:
    ```
    cp env.template.txt .env
    ```

3. Build the Docker containers:
    Ensure that the `bin.zip` file is unzipped during the build process. Add the following command to your `Dockerfile`:
    ```
    RUN unzip /app/bin.zip -d /app/bin
    ```
    Then build the containers:
    ```
    docker-compose build
    ```

4. Start the application:

    Option A: Run in background mode:
    ```
    docker-compose up -d
    ```

    Option B: Run in foreground mode (with logs):
    ```
    docker-compose up
    ```

5. Stop the application:
    ```
    docker-compose down
    ```

---

#### Note:
We strongly recommend using the Docker method as it provides:
- Consistent environment across different machines
- No compatibility issues
- All dependencies pre-configured
- Easier setup and maintenance
