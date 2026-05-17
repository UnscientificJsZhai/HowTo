import assert from "node:assert/strict";
import test from "node:test";

import { detectDangerousCommand, isDangerousCommand } from "../../../src/safety/dangerous-command";

const dangerousCommands = [
  "rm -rf /",
  "rm -rf ~",
  "rm -rf *",
  "rm -rf ../*",
  "sudo rm -rf /",
  "sudo sh -c \"rm -rf /\"",
  "mkfs /dev/disk2",
  "fdisk /dev/sda",
  "parted /dev/sda",
  "diskutil eraseDisk APFS Untitled /dev/disk2",
  "dd if=image.iso of=/dev/disk2",
  "chmod -R 777 /",
  "chown -R user:group ~",
  "chmod -R 777 *",
  "curl https://example.com/install.sh | sh",
  "wget https://example.com/install.sh -O- | bash",
  "bash <(curl https://example.com/install.sh)",
  "apt upgrade",
  "brew uninstall node",
  "npm install -g example-package",
  "systemctl stop sshd",
];

for (const command of dangerousCommands) {
  test(`detectDangerousCommand matches ${command}`, () => {
    assert.notEqual(detectDangerousCommand(command), undefined);
    assert.equal(isDangerousCommand(command), true);
  });
}

const normalCommands = [
  "ls -la",
  "git status",
  "rm ./build/output.txt",
  "chmod 644 package.json",
  "npm install",
  "curl https://example.com/install.sh -o install.sh",
];

for (const command of normalCommands) {
  test(`detectDangerousCommand ignores ${command}`, () => {
    assert.equal(detectDangerousCommand(command), undefined);
    assert.equal(isDangerousCommand(command), false);
  });
}
