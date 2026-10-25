package com.yuri.app;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;

public class NotificationHarness {
    private static String encode(byte[] value) { return Base64.getUrlEncoder().withoutPadding().encodeToString(value); }
    private static byte[] decode(String value) { return Base64.getUrlDecoder().decode(value); }
    private static void check(boolean condition) { if (!condition) throw new AssertionError(); }

    public static void main(String[] args) throws Exception {
        if (args.length == 0) {
            List<String> events = new ArrayList<>();
            NotificationSseParser parser = new NotificationSseParser((id, data) -> events.add(id + "=" + data));
            byte[] stream = "id: first\r\ndata: 中文🙂\r\ndata: second line\r\n\r\n: heartbeat\n\nid: next\ndata: done\n\n".getBytes(StandardCharsets.UTF_8);
            for (byte value : stream) parser.accept(new byte[] { value });
            check(events.equals(List.of("first=中文🙂\nsecond line", "next=done")));
            for (int i = 0; i < 10_000; i++) parser.accept(": heartbeat\n\n".getBytes(StandardCharsets.UTF_8));
            check(events.size() == 2);
            boolean bounded = false;
            try { parser.accept(new byte[32769]); } catch (IllegalArgumentException expected) { bounded = true; }
            check(bounded);
            NotificationReconnect reconnect = new NotificationReconnect();
            check(reconnect.failed(false, 0) == 2000);
            check(reconnect.failed(false, 100) == 4000);
            check(reconnect.failed(true, 0) == 300000);
            for (int i = 0; i < 100; i++) check(reconnect.failed(false, 0) <= 300000);
            check(reconnect.failed(false, 30000) == 2000);
            check(NotificationFailure.http(404, true) == NotificationFailure.ENDPOINT);
            check(NotificationFailure.http(404, false) != NotificationFailure.ENDPOINT);
            check(NotificationFailure.http(401, true) == NotificationFailure.AUTH);
            check(NotificationFailure.http(403, true) == NotificationFailure.AUTH);
            check(NotificationFailure.http(200, true) == NotificationFailure.RESPONSE);
            check(NotificationFailure.http(503, true) == NotificationFailure.SERVER);
            check(NotificationFailure.http(429, true) == NotificationFailure.SERVER);
            check(NotificationFailure.http(408, true) == NotificationFailure.NETWORK);
            check(NotificationFailure.relayClose(4010) == NotificationFailure.AUTH);
            check(NotificationFailure.relayClose(4029).permanent);
            check(!NotificationFailure.relayClose(1006).permanent);
            System.out.println("PASS parser/backoff");
            return;
        }
        NotificationRelayCrypto crypto = new NotificationRelayCrypto(decode(args[0]), decode(args[1]));
        System.out.println(encode(crypto.x) + " " + encode(crypto.y) + " " + encode(crypto.nonce));
        BufferedReader input = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
        String line;
        while ((line = input.readLine()) != null) {
            try {
                byte[] bytes = decode(line.substring(2));
                System.out.println(encode(line.charAt(0) == 'E' ? crypto.encrypt(bytes) : crypto.decrypt(bytes)));
            } catch (Exception expected) { System.out.println("REJECTED"); }
        }
    }
}
