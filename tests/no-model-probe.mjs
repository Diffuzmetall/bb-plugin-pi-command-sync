export default function (pi) {
  pi.registerCommand("bb-probe", {
    description: "Regression probe: a command that does not start an agent run",
    handler: async () => pi.sendMessage({customType: "bb-probe", content: "Command executed", display: true}),
  });
  // Prevent any model request while proving whether slash input was dispatched.
  pi.on("input", (event) => {
    pi.sendMessage({customType: "bb-probe-fallback", content: `FELL THROUGH: ${event.text}`, display: true});
    return {action: "handled"};
  });
}
