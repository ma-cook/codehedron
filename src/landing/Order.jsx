import { useRef, useEffect } from 'react';
import { Line } from '@react-three/drei';
import { useThree } from '@react-three/fiber';

export function OrderHeader(props) {
  const groupRef = useRef();
  const { viewport } = useThree();

  // Set static position without animation
  useEffect(() => {
    if (groupRef.current) {
      // Static positioning - no animation
      // Make positioning responsive to screen size
      const isMobile = viewport.width < 5; // Adjust threshold as needed
      const positionX = isMobile ? -viewport.width / 3 : -viewport.width / 12.8;
      const positionY = viewport.height / 2.5;
      const scale = Math.max(3, Math.min(1.0, viewport.width / 2000));

      groupRef.current.position.set(positionX, positionY, -0);
      groupRef.current.scale.set(scale, scale, scale);
    }
  }, [viewport.width, viewport.height]);

  // Define wireframe letters for "CODEHEDRON"
  const letterSpacing = 10;
  const letterHeight = 10;
  const strokeWidth = 1;

  // Letter C
  const letterC = [
    [6, letterHeight, 0],
    [0, letterHeight, 0],
    [0, letterHeight, 0],
    [0, 0, 0],
    [0, 0, 0],
    [6, 0, 0],
  ];

  // Letter O
  const letterO = [
    [0, 0, 0],
    [0, letterHeight, 0],
    [0, letterHeight, 0],
    [6, letterHeight, 0],
    [6, letterHeight, 0],
    [6, 0, 0],
    [6, 0, 0],
    [0, 0, 0],
  ];

  // Letter D
  const letterD = [
    [0, 0, 0],
    [0, letterHeight, 0],
    [0, letterHeight, 0],
    [4, letterHeight, 0],
    [4, letterHeight, 0],
    [6, letterHeight - 2, 0],
    [6, letterHeight - 2, 0],
    [6, 2, 0],
    [6, 2, 0],
    [4, 0, 0],
    [4, 0, 0],
    [0, 0, 0],
  ];

  // Letter E
  const letterE = [
    [0, 0, 0],
    [0, letterHeight, 0],
    [0, letterHeight, 0],
    [5, letterHeight, 0],
    [0, letterHeight / 2, 0],
    [4, letterHeight / 2, 0],
    [0, 0, 0],
    [5, 0, 0],
  ];

  // Letter H
  const letterH = [
    [0, 0, 0],
    [0, letterHeight, 0],
    [6, 0, 0],
    [6, letterHeight, 0],
    [0, letterHeight / 2, 0],
    [6, letterHeight / 2, 0],
  ];

  // Letter R
  const letterR = [
    [0, 0, 0],
    [0, letterHeight, 0],
    [0, letterHeight, 0],
    [4, letterHeight, 0],
    [4, letterHeight, 0],
    [5, letterHeight - 1, 0],
    [5, letterHeight - 1, 0],
    [5, letterHeight / 2 + 1, 0],
    [5, letterHeight / 2 + 1, 0],
    [4, letterHeight / 2, 0],
    [4, letterHeight / 2, 0],
    [0, letterHeight / 2, 0],
    [3, letterHeight / 2, 0],
    [6, 0, 0],
  ];

  // Letter N
  const letterN = [
    [0, 0, 0],
    [0, letterHeight, 0],
    [0, letterHeight, 0],
    [6, 0, 0],
    [6, 0, 0],
    [6, letterHeight, 0],
  ];

  return (
    <group ref={groupRef} {...props}>
      {/* C */}
      <Line points={letterC} color="#333333" lineWidth={strokeWidth} />

      {/* O */}
      <group position={[letterSpacing * 1, 0, 0]}>
        <Line points={letterO} color="#333333" lineWidth={strokeWidth} />
      </group>

      {/* D */}
      <group position={[letterSpacing * 2, 0, 0]}>
        <Line points={letterD} color="#333333" lineWidth={strokeWidth} />
      </group>

      {/* E */}
      <group position={[letterSpacing * 3, 0, 0]}>
        <Line points={letterE} color="#333333" lineWidth={strokeWidth} />
      </group>

      {/* H */}
      <group position={[letterSpacing * 4, 0, 0]}>
        <Line points={letterH} color="#333333" lineWidth={strokeWidth} />
      </group>

      {/* E */}
      <group position={[letterSpacing * 5, 0, 0]}>
        <Line points={letterE} color="#333333" lineWidth={strokeWidth} />
      </group>

      {/* D */}
      <group position={[letterSpacing * 6, 0, 0]}>
        <Line points={letterD} color="#333333" lineWidth={strokeWidth} />
      </group>

      {/* R */}
      <group position={[letterSpacing * 7, 0, 0]}>
        <Line points={letterR} color="#333333" lineWidth={strokeWidth} />
      </group>

      {/* O */}
      <group position={[letterSpacing * 8, 0, 0]}>
        <Line points={letterO} color="#333333" lineWidth={strokeWidth} />
      </group>

      {/* N */}
      <group position={[letterSpacing * 9, 0, 0]}>
        <Line points={letterN} color="#333333" lineWidth={strokeWidth} />
      </group>
    </group>
  );
}
