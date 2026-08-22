package gamevault.minecraft;

import java.io.IOException;
import java.lang.instrument.Instrumentation;
import java.lang.management.ManagementFactory;
import java.lang.reflect.Method;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.nio.charset.StandardCharsets;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.nio.file.attribute.PosixFilePermission;
import java.time.Instant;
import java.util.ArrayList;
import java.util.EnumSet;
import java.util.List;
import java.util.Locale;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Consumer;

public final class MinecraftEventAgentV2 {
    private static final AtomicBoolean STARTED = new AtomicBoolean(false);
    private static final AtomicBoolean BOOTSTRAP_SCHEDULED = new AtomicBoolean(false);
    private static final AtomicBoolean HEARTBEAT_STARTED = new AtomicBoolean(false);
    private static final AtomicBoolean COLLECTOR_READY = new AtomicBoolean(false);
    private static final AtomicBoolean COLLECTOR_STOPPED = new AtomicBoolean(false);
    private static final AtomicReference<String> COLLECTOR_ERROR = new AtomicReference<>();
    private static final AtomicLong SEQUENCE = new AtomicLong(0);
    private static final String RUN_ID = UUID.randomUUID().toString();
    private static final Object JOURNAL_LOCK = new Object();
    private static final Object STATUS_LOCK = new Object();
    private static final List<Consumer<Object>> LISTENERS = new ArrayList<>();

    private MinecraftEventAgentV2() {}

    public static void premain(String arguments, Instrumentation instrumentation) {
        start(arguments, instrumentation);
    }

    public static void agentmain(String arguments, Instrumentation instrumentation) {
        start(arguments, instrumentation);
    }

    private static void start(String arguments, Instrumentation instrumentation) {
        if (!STARTED.compareAndSet(false, true)) return;
        Path outputDirectory = Path.of(argument(arguments, "output", "events"));
        Thread installer = new Thread(() -> installWhenReady(instrumentation, outputDirectory), "game-vault-minecraft-events");
        installer.setDaemon(true);
        installer.start();
    }

    private static String argument(String arguments, String key, String fallback) {
        if (arguments == null || arguments.isBlank()) return fallback;
        for (String part : arguments.split("\\|")) {
            int split = part.indexOf('=');
            if (split > 0 && part.substring(0, split).equals(key)) return part.substring(split + 1);
        }
        return fallback;
    }

    private static void installWhenReady(Instrumentation instrumentation, Path outputDirectory) {
        while (!Thread.currentThread().isInterrupted()) {
            try {
                Object server = currentServer(instrumentation);
                if (server != null && BOOTSTRAP_SCHEDULED.compareAndSet(false, true)) {
                    scheduleBootstrap(server, () -> {
                        try {
                            append(outputDirectory, "run-start", null, null);
                            installListeners(instrumentation, outputDirectory);
                            appendPresentPlayers(outputDirectory, server);
                            COLLECTOR_READY.set(true);
                            writeCollectorStatusSafely(outputDirectory);
                            startHeartbeat(outputDirectory);
                        } catch (Throwable error) {
                            reportCollectorError(error);
                            writeCollectorStatusSafely(outputDirectory);
                        }
                    });
                    return;
                }
            } catch (Throwable ignored) {
                BOOTSTRAP_SCHEDULED.set(false);
            }
            try {
                Thread.sleep(1_000);
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
            }
        }
    }

    private static void scheduleBootstrap(Object server, Runnable bootstrap) throws Exception {
        Method execute = findMethod(server.getClass(), "execute", Runnable.class);
        if (execute == null) throw new NoSuchMethodException(server.getClass().getName() + ".execute(Runnable)");
        execute.setAccessible(true);
        execute.invoke(server, bootstrap);
    }

    @SuppressWarnings({"unchecked", "rawtypes"})
    private static void installListeners(Instrumentation instrumentation, Path outputDirectory) throws Exception {
        Class<?> lifecycleHooks = loadedClass(instrumentation, "net.minecraftforge.server.ServerLifecycleHooks");
        ClassLoader loader = lifecycleHooks.getClassLoader();
        Class<?> minecraftForge = Class.forName("net.minecraftforge.common.MinecraftForge", true, loader);
        Object eventBus = minecraftForge.getField("EVENT_BUS").get(null);
        Class<?> priorityClass = Class.forName("net.minecraftforge.eventbus.api.EventPriority", true, loader);
        Object normalPriority = Enum.valueOf((Class<? extends Enum>) priorityClass.asSubclass(Enum.class), "NORMAL");
        Method addListener = eventBus.getClass().getMethod("addListener", priorityClass, boolean.class, Class.class, Consumer.class);
        Method unregister = eventBus.getClass().getMethod("unregister", Object.class);
        Class<?>[] eventClasses = {
            Class.forName("net.minecraftforge.event.entity.player.PlayerEvent$PlayerLoggedInEvent", true, loader),
            Class.forName("net.minecraftforge.event.entity.player.PlayerEvent$PlayerLoggedOutEvent", true, loader),
            Class.forName("net.minecraftforge.event.server.ServerStoppedEvent", true, loader)
        };
        List<Consumer<Object>> candidates = List.of(
            event -> appendPlayerEvent(outputDirectory, "join", event),
            event -> appendPlayerEvent(outputDirectory, "leave", event),
            event -> {
                appendSystemEvent(outputDirectory, "server-stop");
                COLLECTOR_STOPPED.set(true);
                COLLECTOR_READY.set(false);
                writeCollectorStatusSafely(outputDirectory);
            }
        );
        int registered = 0;
        try {
            for (int index = 0; index < candidates.size(); index++) {
                addListener.invoke(eventBus, normalPriority, false, eventClasses[index], candidates.get(index));
                registered++;
            }
        } catch (Throwable error) {
            for (int index = 0; index < registered; index++) {
                try { unregister.invoke(eventBus, candidates.get(index)); } catch (Throwable ignored) {}
            }
            throw new IllegalStateException("Forge listener registration was incomplete", error);
        }
        LISTENERS.addAll(candidates);
    }

    private static void appendPresentPlayers(Path outputDirectory, Object server) throws Exception {
        Object playerList = invokeAny(server, "getPlayerList", "m_6846_");
        for (Object player : list(invokeAny(playerList, "getPlayers", "m_11314_"))) {
            appendPlayer(outputDirectory, "present", player);
        }
    }

    private static void appendPlayerEvent(Path outputDirectory, String type, Object event) {
        try {
            appendPlayer(outputDirectory, type, invokeAny(event, "getEntity", "getPlayer"));
        } catch (Throwable error) {
            reportCollectorError(error);
            writeCollectorStatusSafely(outputDirectory);
        }
    }

    private static void appendPlayer(Path outputDirectory, String type, Object player) throws Exception {
        Object profile = invokeByReturnType(player, "com.mojang.authlib.GameProfile");
        String name = String.valueOf(invoke(profile, "getName"));
        String playerId = String.valueOf(invoke(profile, "getId"));
        append(outputDirectory, type, playerId, name);
    }

    private static void appendSystemEvent(Path outputDirectory, String type) {
        try {
            append(outputDirectory, type, null, null);
        } catch (Throwable error) {
            reportCollectorError(error);
            writeCollectorStatusSafely(outputDirectory);
        }
    }

    private static void append(Path outputDirectory, String type, String playerId, String playerName) throws IOException {
        synchronized (JOURNAL_LOCK) {
            long sequence = SEQUENCE.get() + 1;
            String eventId = RUN_ID + ":" + sequence;
            StringBuilder json = new StringBuilder(256);
            json.append("{\"v\":1");
            json.append(",\"eventId\":\"").append(escape(eventId)).append("\"");
            json.append(",\"runId\":\"").append(escape(RUN_ID)).append("\"");
            json.append(",\"seq\":").append(sequence);
            json.append(",\"type\":\"").append(escape(type)).append("\"");
            json.append(",\"at\":\"").append(Instant.now()).append("\"");
            json.append(",\"jvmUptimeMs\":").append(Math.max(0, ManagementFactory.getRuntimeMXBean().getUptime()));
            if (playerId != null && playerName != null) {
                json.append(",\"player\":{\"uuid\":\"").append(escape(playerId)).append("\",\"name\":\"").append(escape(playerName)).append("\"}");
            }
            json.append('}').append(System.lineSeparator());
            Files.createDirectories(outputDirectory);
            ownerOnlyDirectory(outputDirectory);
            Path journal = outputDirectory.resolve(RUN_ID + ".ndjson");
            try (FileChannel channel = FileChannel.open(journal,
                    StandardOpenOption.CREATE, StandardOpenOption.WRITE, StandardOpenOption.APPEND)) {
                ByteBuffer buffer = ByteBuffer.wrap(json.toString().getBytes(StandardCharsets.UTF_8));
                while (buffer.hasRemaining()) channel.write(buffer);
                channel.force(false);
            }
            SEQUENCE.set(sequence);
            ownerOnly(journal);
        }
    }

    private static void startHeartbeat(Path outputDirectory) {
        if (!HEARTBEAT_STARTED.compareAndSet(false, true)) return;
        Thread heartbeat = new Thread(() -> {
            while (!COLLECTOR_STOPPED.get() && !Thread.currentThread().isInterrupted()) {
                writeCollectorStatusSafely(outputDirectory);
                try {
                    Thread.sleep(5_000);
                } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                }
            }
        }, "game-vault-minecraft-event-heartbeat");
        heartbeat.setDaemon(true);
        heartbeat.start();
    }

    private static void writeCollectorStatusSafely(Path outputDirectory) {
        try {
            writeCollectorStatus(outputDirectory);
        } catch (Throwable error) {
            reportCollectorError(error);
        }
    }

    private static void writeCollectorStatus(Path outputDirectory) throws IOException {
        synchronized (STATUS_LOCK) {
            Files.createDirectories(outputDirectory);
            ownerOnlyDirectory(outputDirectory);
            String error = COLLECTOR_ERROR.get();
            boolean ready = COLLECTOR_READY.get() && !COLLECTOR_STOPPED.get() && error == null;
            String state = COLLECTOR_STOPPED.get() ? "stopped" : error != null ? "degraded" : ready ? "live" : "starting";
            StringBuilder json = new StringBuilder(220);
            json.append("{\"v\":1,\"runId\":\"").append(escape(RUN_ID)).append("\"");
            json.append(",\"ready\":").append(ready);
            json.append(",\"state\":\"").append(state).append("\"");
            json.append(",\"sampledAt\":\"").append(Instant.now()).append("\"");
            json.append(",\"jvmUptimeMs\":").append(Math.max(0, ManagementFactory.getRuntimeMXBean().getUptime()));
            json.append(",\"lastSequence\":").append(SEQUENCE.get());
            json.append(",\"error\":").append(error == null ? "null" : "\"" + escape(error) + "\"");
            json.append('}').append(System.lineSeparator());
            Path status = outputDirectory.resolve("status.json");
            Path temporary = outputDirectory.resolve(".status-" + RUN_ID + ".tmp");
            Files.writeString(temporary, json, StandardCharsets.UTF_8,
                StandardOpenOption.CREATE, StandardOpenOption.TRUNCATE_EXISTING, StandardOpenOption.WRITE);
            ownerOnly(temporary);
            try {
                Files.move(temporary, status, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
            } catch (AtomicMoveNotSupportedException unsupported) {
                Files.move(temporary, status, StandardCopyOption.REPLACE_EXISTING);
            }
            ownerOnly(status);
        }
    }

    private static void reportCollectorError(Throwable error) {
        String reason = error == null ? "UnknownError" : error.getClass().getSimpleName();
        COLLECTOR_READY.set(false);
        if (COLLECTOR_ERROR.compareAndSet(null, reason)) {
            System.err.println("[Game Vault] Minecraft player event collector degraded: " + reason);
        }
    }

    private static void ownerOnly(Path file) {
        try {
            Files.setPosixFilePermissions(file, EnumSet.of(PosixFilePermission.OWNER_READ, PosixFilePermission.OWNER_WRITE));
        } catch (Throwable ignored) {
        }
    }

    private static void ownerOnlyDirectory(Path directory) {
        try {
            Files.setPosixFilePermissions(directory, EnumSet.of(
                PosixFilePermission.OWNER_READ,
                PosixFilePermission.OWNER_WRITE,
                PosixFilePermission.OWNER_EXECUTE));
        } catch (Throwable ignored) {
        }
    }

    private static Object currentServer(Instrumentation instrumentation) throws Exception {
        Class<?> hooks = loadedClass(instrumentation, "net.minecraftforge.server.ServerLifecycleHooks");
        return hooks.getMethod("getCurrentServer").invoke(null);
    }

    private static Class<?> loadedClass(Instrumentation instrumentation, String name) throws ClassNotFoundException {
        for (Class<?> loaded : instrumentation.getAllLoadedClasses()) {
            if (loaded.getName().equals(name)) return loaded;
        }
        throw new ClassNotFoundException(name);
    }

    private static Object invoke(Object target, String methodName) throws Exception {
        Method method = findMethod(target.getClass(), methodName);
        if (method == null) throw new NoSuchMethodException(target.getClass().getName() + "." + methodName + "()");
        method.setAccessible(true);
        return method.invoke(target);
    }

    private static Object invokeAny(Object target, String... methodNames) throws Exception {
        for (String methodName : methodNames) {
            Method method = findMethod(target.getClass(), methodName);
            if (method == null) continue;
            method.setAccessible(true);
            return method.invoke(target);
        }
        throw new NoSuchMethodException(target.getClass().getName() + "." + String.join("/", methodNames) + "()");
    }

    private static Object invokeByReturnType(Object target, String returnTypeName) throws Exception {
        for (Class<?> current = target.getClass(); current != null; current = current.getSuperclass()) {
            for (Method method : current.getDeclaredMethods()) {
                if (method.getParameterCount() != 0 || !method.getReturnType().getName().equals(returnTypeName)) continue;
                method.setAccessible(true);
                return method.invoke(target);
            }
        }
        throw new NoSuchMethodException(target.getClass().getName() + " -> " + returnTypeName);
    }

    private static Method findMethod(Class<?> type, String name, Class<?>... parameterTypes) {
        for (Class<?> current = type; current != null; current = current.getSuperclass()) {
            try {
                return current.getDeclaredMethod(name, parameterTypes);
            } catch (NoSuchMethodException ignored) {
            }
        }
        return null;
    }

    private static List<?> list(Object value) {
        if (value instanceof List<?> values) return values;
        if (value instanceof Iterable<?> values) {
            List<Object> result = new ArrayList<>();
            values.forEach(result::add);
            return result;
        }
        return List.of();
    }

    private static String escape(String value) {
        if (value == null) return "";
        StringBuilder escaped = new StringBuilder(value.length() + 16);
        for (int index = 0; index < value.length(); index++) {
            char character = value.charAt(index);
            switch (character) {
                case '\\' -> escaped.append("\\\\");
                case '"' -> escaped.append("\\\"");
                case '\n' -> escaped.append("\\n");
                case '\r' -> escaped.append("\\r");
                case '\t' -> escaped.append("\\t");
                default -> {
                    if (character < 0x20) escaped.append(String.format(Locale.ROOT, "\\u%04x", (int) character));
                    else escaped.append(character);
                }
            }
        }
        return escaped.toString();
    }
}
