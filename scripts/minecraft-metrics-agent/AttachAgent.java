package gamevault.minecraft;

import com.sun.tools.attach.VirtualMachine;

public final class AttachAgent {
    private AttachAgent() {}

    public static void main(String[] arguments) throws Exception {
        if (arguments.length != 3) throw new IllegalArgumentException("usage: AttachAgent <pid> <agent.jar> <agent-args>");
        VirtualMachine machine = VirtualMachine.attach(arguments[0]);
        try {
            machine.loadAgent(arguments[1], arguments[2]);
        } finally {
            machine.detach();
        }
    }
}
