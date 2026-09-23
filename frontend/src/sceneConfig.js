export const SCENE_CONFIG = {
  Multimedia: {
    title: 'Multimedia',
    category: 'Multimedia Computing',
    modelUrl: '/assets/scene/scene.glb',
    environmentPreset: 'sunset',
    userStart: {
      position: [0, 0, 0],
      rotation: [0, Math.PI, 0],
      animation: 'Idle',
    },
    assistant: {
      position: [0, 1.0, -6],
      animation: 'Idle',
    },
    courseContent:
      'Multimedia computing course with AI-generated lecture explanations.',
  },
  ELG5121: {
    title: 'ELG 5121',
    category: 'Engineering',
    modelUrl: '/assets/scene/modified-classroom.glb',
    environmentPreset: 'sunset',
    userStart: {
      position: [0, 0, 0],
      rotation: [0, Math.PI, 0],
      animation: 'Idle',
    },
    assistant: {
      position: [0, 1.0, -6],
      animation: 'Idle',
    },
    courseContent:
      'Advanced engineering problem-solving lab with interactive simulations and digital twin demonstrations.',
  },
  CS401: {
    title: 'CS 401',
    category: 'Computer Science',
    modelUrl: '/assets/scene/modified-classroom.glb',
    environmentPreset: 'warehouse',
    userStart: {
      position: [1, 0, 0],
      rotation: [0, Math.PI, 0],
      animation: 'Idle',
    },
    assistant: {
      position: [1, 1.0, -6],
      animation: 'Idle',
    },
    courseContent:
      'Computer science seminar with live coding, virtual servers, and collaborative debugging spaces.',
  },
  MED320: {
    title: 'MED 320',
    category: 'Healthcare',
    modelUrl: '/assets/scene/modified-classroom.glb',
    environmentPreset: 'apartment',
    userStart: {
      position: [-1, 0, 0],
      rotation: [0, Math.PI, 0],
      animation: 'Idle',
    },
    assistant: {
      position: [-1, 1.0, -6],
      animation: 'Idle',
    },
    courseContent:
      'Medical training room with virtual anatomy models and patient simulation scenarios.',
  },
  BIO210: {
    title: 'BIO 210',
    category: 'Science',
    modelUrl: '/assets/scene/modified-classroom.glb',
    environmentPreset: 'forest',
    userStart: {
      position: [0, 0, 1],
      rotation: [0, Math.PI, 0],
      animation: 'Idle',
    },
    assistant: {
      position: [0, 1.0, -5],
      animation: 'Idle',
    },
    courseContent:
      'Biology lab with microscopy data, molecular models, and ecosystem exploration.',
  },
  MTH150: {
    title: 'MTH 150',
    category: 'Mathematics',
    modelUrl: '/assets/scene/modified-classroom.glb',
    environmentPreset: 'studio',
    userStart: {
      position: [2, 0, 0],
      rotation: [0, Math.PI, 0],
      animation: 'Idle',
    },
    assistant: {
      position: [2, 1.0, -6],
      animation: 'Idle',
    },
    courseContent:
      'Mathematics workspace with interactive graphing, theorem walkthroughs, and problem boards.',
  },
  VR101: {
    title: 'VR 101',
    category: 'Virtual Labs',
    modelUrl: '/assets/scene/modified-classroom.glb',
    environmentPreset: 'city',
    userStart: {
      position: [-2, 0, 0],
      rotation: [0, Math.PI, 0],
      animation: 'Idle',
    },
    assistant: {
      position: [-2, 1.0, -6],
      animation: 'Idle',
    },
    courseContent:
      'Introductory virtual reality sandbox for experimenting with WebXR tools and environments.',
  },
};
