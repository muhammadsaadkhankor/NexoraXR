import React from 'react';

const AvatarFileSelector = ({ onAvatarChange }) => {
  const handleFileChange = (event) => {
    const file = event.target.files[0];
    if (file) {
      // Create blob URL and log it
      const blobUrl = URL.createObjectURL(file);
      console.log('New avatar URL:', blobUrl);
      
      // Clear the input value to allow selecting the same file again
      event.target.value = '';
      
      onAvatarChange(blobUrl);
    }
  };

  return (
    <div className="fixed top-20 right-4 z-20">
      <label className="flex items-center gap-2 bg-white bg-opacity-50 backdrop-blur-md p-4 rounded-lg cursor-pointer hover:bg-opacity-70 text-gray-700">
        <svg 
          xmlns="http://www.w3.org/2000/svg" 
          fill="none" 
          viewBox="0 0 24 24" 
          strokeWidth={1.5} 
          stroke="currentColor" 
          className="w-5 h-5"
        >
          <path 
            strokeLinecap="round" 
            strokeLinejoin="round" 
            d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5" 
          />
        </svg>
        <span>Change Avatar</span>
        <input
          type="file"
          accept=".glb"
          onChange={handleFileChange}
          className="hidden"
        />
      </label>
    </div>
  );
};

export default AvatarFileSelector;