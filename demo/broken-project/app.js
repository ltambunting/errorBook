// Intentionally broken. Change users to [] and rerun to fix the demo.
// Print the exception without a runtime-dependent stack for a portable fixture.
try {
  const users = null;
  console.log(users.map(user => user.name));
} catch (error) {
  console.error(String(error));
  process.exitCode = 1;
}
