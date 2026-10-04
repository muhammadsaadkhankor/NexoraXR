import { useGLTF } from "@react-three/drei";
import React, { useEffect } from "react";

export function CheckSkeleton() {
  const { nodes } = useGLTF("/assets/avatar/ProfAbed_suit.glb");

  useEffect(() => {
    // Function to recursively print the skeleton hierarchy
    const printSkeleton = (object, level = 0) => {
      console.log(`${' '.repeat(level * 2)}${object.name} (${object.type})`);

      if (object.children.length > 0) {
        object.children.forEach((child) => printSkeleton(child, level + 1));
      }
    };

    // Traverse and find skinned meshes to log their skeleton
    Object.keys(nodes).forEach((key) => {
      const node = nodes[key];

      if (node.isSkinnedMesh && node.skeleton) {
        console.log(`Skeleton for ${node.name}:`);
        printSkeleton(node.skeleton.bones[0]); // Start logging from the root bone
      }
    });
  }, [nodes]);

  return null; // This component only performs logging and doesn't render anything
}

useGLTF.preload("/assets/avatar/ProfAbed_suit.glb");
