// Intentionally broken. Replace the empty string with '{}' to fix this example.
try {
  JSON.parse('');
} catch (error) {
  console.error(String(error));
  process.exitCode = 1;
}
