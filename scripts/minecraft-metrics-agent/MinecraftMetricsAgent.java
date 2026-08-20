package gamevault.minecraft;

import java.io.IOException;
import java.lang.instrument.Instrumentation;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.lang.management.ManagementFactory;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.atomic.AtomicBoolean;

public final class MinecraftMetricsAgent {
    private static final AtomicBoolean STARTED = new AtomicBoolean(false);

    private MinecraftMetricsAgent() {}

    public static void premain(String arguments, Instrumentation instrumentation) {
        start(arguments, instrumentation);
    }

    public static void agentmain(String arguments, Instrumentation instrumentation) {
        start(arguments, instrumentation);
    }

    private static void start(String arguments, Instrumentation instrumentation) {
        if (!STARTED.compareAndSet(false, true)) return;
        Path output = Path.of(argument(arguments, "output", "status.json"));
        Thread worker = new Thread(() -> monitor(instrumentation, output), "game-vault-minecraft-metrics");
        worker.setDaemon(true);
        worker.start();
    }

    private static String argument(String arguments, String key, String fallback) {
        if (arguments == null || arguments.isBlank()) return fallback;
        for (String part : arguments.split("\\|")) {
            int split = part.indexOf('=');
            if (split > 0 && part.substring(0, split).equals(key)) return part.substring(split + 1);
        }
        return fallback;
    }

    private static void monitor(Instrumentation instrumentation, Path output) {
        while (!Thread.currentThread().isInterrupted()) {
            try {
                Object server = currentServer(instrumentation);
                if (server != null) writeSnapshot(output, snapshot(server));
            } catch (Throwable error) {
                try {
                    writeSnapshot(output, "{\"sampledAt\":\"" + Instant.now() + "\",\"error\":\"" + escape(error.getClass().getSimpleName() + ": " + error.getMessage()) + "\"}");
                } catch (Throwable ignored) {
                }
            }
            try {
                Thread.sleep(2_000);
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
            }
        }
    }

    private static Object currentServer(Instrumentation instrumentation) throws Exception {
        for (Class<?> loaded : instrumentation.getAllLoadedClasses()) {
            if (!loaded.getName().equals("net.minecraftforge.server.ServerLifecycleHooks")) continue;
            Method method = loaded.getMethod("getCurrentServer");
            return method.invoke(null);
        }
        return null;
    }

    private static String snapshot(Object server) throws Exception {
        double mspt = averageTickTime(server);
        double tps = mspt <= 0 ? 20.0 : Math.min(20.0, 1_000.0 / mspt);
        Object playerList = invokeAny(server, "getPlayerList", "m_6846_");
        List<?> players = list(invokeAny(playerList, "getPlayers", "m_11314_"));
        int maxPlayers = intValue(invokeAnyOptional(playerList, "getMaxPlayers", "m_11310_"), 0);
        long uptimeSeconds = Math.max(0, ManagementFactory.getRuntimeMXBean().getUptime() / 1_000);
        Runtime runtime = Runtime.getRuntime();
        long usedMb = (runtime.totalMemory() - runtime.freeMemory()) / 1024 / 1024;
        long maxMb = runtime.maxMemory() / 1024 / 1024;

        StringBuilder json = new StringBuilder(512);
        json.append("{\"sampledAt\":\"").append(Instant.now()).append("\"");
        json.append(",\"tps\":").append(decimal(tps));
        json.append(",\"mspt\":").append(decimal(mspt));
        json.append(",\"uptimeSeconds\":").append(uptimeSeconds);
        json.append(",\"memoryUsedMb\":").append(usedMb);
        json.append(",\"memoryMaxMb\":").append(maxMb);
        json.append(",\"onlinePlayers\":").append(players.size());
        json.append(",\"maxPlayers\":").append(maxPlayers);
        json.append(",\"players\":[");
        for (int index = 0; index < players.size(); index++) {
            if (index > 0) json.append(',');
            Object player = players.get(index);
            Object profile = invokeByReturnType(player, "com.mojang.authlib.GameProfile");
            String name = String.valueOf(invoke(profile, "getName"));
            Integer latency = playerLatency(player);
            json.append("{\"name\":\"").append(escape(name)).append("\",\"latencyMs\":");
            if (latency == null) json.append("null");
            else json.append(Math.max(0, latency));
            json.append('}');
        }
        json.append("]}");
        return json.toString();
    }

    private static double averageTickTime(Object server) throws Exception {
        Object direct = invokeAnyOptional(server, "getAverageTickTime", "m_129903_");
        if (direct instanceof Number number) return Math.max(0, number.doubleValue());
        for (String fieldName : List.of("averageTickTime", "tickTimesNanos", "tickTimes")) {
            Field field = findField(server.getClass(), fieldName);
            if (field == null) continue;
            field.setAccessible(true);
            Object value = field.get(server);
            if (value instanceof Number number) return Math.max(0, number.doubleValue());
            if (value instanceof long[] samples) {
                long total = 0;
                int count = 0;
                for (long sample : samples) {
                    if (sample <= 0) continue;
                    total += sample;
                    count += 1;
                }
                if (count > 0) return (total / (double) count) / 1_000_000.0;
            }
        }
        return 0;
    }

    private static Integer playerLatency(Object player) {
        for (Object target : new Object[] { player, fieldValue(player, "connection") }) {
            if (target == null) continue;
            for (String methodName : List.of("getLatency", "getPing")) {
                Object result = invokeOptional(target, methodName);
                if (result instanceof Number number) return number.intValue();
            }
            for (String fieldName : List.of("latency", "ping", "f_8943_")) {
                Object result = fieldValue(target, fieldName);
                if (result instanceof Number number) return number.intValue();
            }
        }
        return null;
    }

    private static Object fieldValue(Object target, String name) {
        if (target == null) return null;
        try {
            Field field = findField(target.getClass(), name);
            if (field == null) return null;
            field.setAccessible(true);
            return field.get(target);
        } catch (Exception ignored) {
            return null;
        }
    }

    private static Field findField(Class<?> type, String name) {
        for (Class<?> current = type; current != null; current = current.getSuperclass()) {
            try {
                return current.getDeclaredField(name);
            } catch (NoSuchFieldException ignored) {
            }
        }
        return null;
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

    private static Object invokeAnyOptional(Object target, String... methodNames) {
        if (target == null) return null;
        try {
            return invokeAny(target, methodNames);
        } catch (Exception ignored) {
            return null;
        }
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

    private static Method findMethod(Class<?> type, String name) {
        for (Class<?> current = type; current != null; current = current.getSuperclass()) {
            try {
                return current.getDeclaredMethod(name);
            } catch (NoSuchMethodException ignored) {
            }
        }
        return null;
    }

    private static Object invokeOptional(Object target, String methodName) {
        if (target == null) return null;
        try {
            return invoke(target, methodName);
        } catch (Exception ignored) {
            return null;
        }
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

    private static int intValue(Object value, int fallback) {
        return value instanceof Number number ? number.intValue() : fallback;
    }

    private static long longValue(Object value, long fallback) {
        return value instanceof Number number ? number.longValue() : fallback;
    }

    private static String decimal(double value) {
        return String.format(Locale.ROOT, "%.3f", value);
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

    private static void writeSnapshot(Path output, String json) throws IOException {
        Path parent = output.toAbsolutePath().getParent();
        if (parent != null) Files.createDirectories(parent);
        Path temporary = output.resolveSibling(output.getFileName() + ".tmp");
        Files.writeString(temporary, json + System.lineSeparator(), StandardCharsets.UTF_8);
        try {
            Files.move(temporary, output, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
        } catch (IOException error) {
            Files.move(temporary, output, StandardCopyOption.REPLACE_EXISTING);
        }
    }
}
