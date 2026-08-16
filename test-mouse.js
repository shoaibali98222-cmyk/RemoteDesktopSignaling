const robot = require('robotjs');

console.log('Move your mouse somewhere. Testing in 3 seconds...');

setTimeout(() => {
  const pos = robot.getMousePos();

  console.log('Current mouse position:', pos);

  robot.moveMouse(pos.x + 100, pos.y);

  console.log('Mouse moved successfully.');
}, 3000);