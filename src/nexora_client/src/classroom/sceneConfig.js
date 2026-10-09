const classroomDefaults = (courseContent, preset, userStart, assistantPos = [0, 1.0, -6]) => ({
  modelUrl: '/assets/scene/scene.glb',
  environmentPreset: preset,
  userStart,
  assistant: { position: assistantPos, animation: 'Idle' },
  courseContent,
});

export const SCENE_CONFIG = {
  ComputerVision: {
    title: 'Computer Vision',
    category: 'Artificial Intelligence',
    ...classroomDefaults(
      'Computer vision course with AI-generated lecture explanations.',
      'sunset',
      { position: [0, 0, 0], rotation: [0, Math.PI, 0], animation: 'Idle' },
    ),
  },
  MachineLearning: {
    title: 'Machine Learning',
    category: 'Artificial Intelligence',
    ...classroomDefaults(
      'Machine learning course with AI-generated lecture explanations.',
      'warehouse',
      { position: [1, 0, 0], rotation: [0, Math.PI, 0], animation: 'Idle' },
      [1, 1.0, -6],
    ),
  },
  ComputerScience: {
    title: 'Computer Science',
    category: 'Computer Science',
    ...classroomDefaults(
      'Computer science course with AI-generated lecture explanations.',
      'city',
      { position: [2, 0, 0], rotation: [0, Math.PI, 0], animation: 'Idle' },
      [2, 1.0, -6],
    ),
  },
  HCI: {
    title: 'Human-Computer Interaction',
    category: 'Interaction Design',
    ...classroomDefaults(
      'Human-computer interaction course with AI-generated lecture explanations.',
      'studio',
      { position: [-1, 0, 0], rotation: [0, Math.PI, 0], animation: 'Idle' },
      [-1, 1.0, -6],
    ),
  },
  Ethics: {
    title: 'Ethics',
    category: 'Humanities',
    ...classroomDefaults(
      'Ethics course with AI-generated lecture explanations.',
      'apartment',
      { position: [-2, 0, 0], rotation: [0, Math.PI, 0], animation: 'Idle' },
      [-2, 1.0, -6],
    ),
  },
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
      'Advanced engineering problem-solving lab with interactive simulations and digital twin demonstrations.',
  },
  CS401: {
    title: 'CS 401',
    category: 'Computer Science',
    modelUrl: '/assets/scene/scene.glb',
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
    modelUrl: '/assets/scene/scene.glb',
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
    modelUrl: '/assets/scene/scene.glb',
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
    modelUrl: '/assets/scene/scene.glb',
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
    modelUrl: '/assets/scene/scene.glb',
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

// The six courses shown on the landing gallery and offered by Create
// Classroom. Keys double as scene names (/scene/<key>) and courseIds.
export const PRIMARY_COURSES = [
  'Multimedia',
  'ComputerVision',
  'MachineLearning',
  'ComputerScience',
  'HCI',
  'Ethics',
];
