import React, { useState, useEffect } from 'react';
import { Text } from 'ink';

const FRAMES = ['|', '/', '-', '\\'];

export const LoadingView: React.FC = () => {
  const [frameIndex, setFrameIndex] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => {
      setFrameIndex((prev) => (prev + 1) % FRAMES.length);
    }, 120);

    return () => clearInterval(timer);
  }, []);

  return (
    <Text>
      <Text color="cyan">{FRAMES[frameIndex]} </Text>
      Thinking...
    </Text>
  );
};
