package com.yuri.app;

import java.math.BigInteger;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.AlgorithmParameters;
import java.security.KeyFactory;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.SecureRandom;
import java.security.interfaces.ECPublicKey;
import java.security.spec.ECGenParameterSpec;
import java.security.spec.ECParameterSpec;
import java.security.spec.ECPoint;
import java.security.spec.ECPublicKeySpec;
import java.util.Arrays;
import javax.crypto.Cipher;
import javax.crypto.KeyAgreement;
import javax.crypto.Mac;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;

/** Native initiator for relay v1. Mirrors the normative UI crypto without changing the wire. */
final class NotificationRelayCrypto {
    final byte[] x;
    final byte[] y;
    final byte[] nonce = new byte[16];
    private final byte[] prefix = new byte[4];
    private final SecretKeySpec outgoing;
    private final SecretKeySpec incoming;
    private long sent;
    private long received;

    NotificationRelayCrypto(byte[] hostX, byte[] hostY) throws Exception {
        if (hostX.length != 32 || hostY.length != 32) throw new IllegalArgumentException("Invalid host key");
        KeyPairGenerator generator = KeyPairGenerator.getInstance("EC");
        generator.initialize(new ECGenParameterSpec("secp256r1"));
        KeyPair pair = generator.generateKeyPair();
        ECPublicKey publicKey = (ECPublicKey) pair.getPublic();
        x = coordinate(publicKey.getW().getAffineX());
        y = coordinate(publicKey.getW().getAffineY());
        SecureRandom random = new SecureRandom();
        random.nextBytes(nonce);
        random.nextBytes(prefix);
        AlgorithmParameters parameters = AlgorithmParameters.getInstance("EC");
        parameters.init(new ECGenParameterSpec("secp256r1"));
        ECPublicKeySpec spec = new ECPublicKeySpec(
            new ECPoint(new BigInteger(1, hostX), new BigInteger(1, hostY)),
            parameters.getParameterSpec(ECParameterSpec.class)
        );
        KeyAgreement agreement = KeyAgreement.getInstance("ECDH");
        agreement.init(pair.getPrivate());
        agreement.doPhase(KeyFactory.getInstance("EC").generatePublic(spec), true);
        byte[] prk = hmac(nonce, agreement.generateSecret());
        byte[] info = "yuri-relay-v1".getBytes(StandardCharsets.UTF_8);
        byte[] firstInput = Arrays.copyOf(info, info.length + 1);
        firstInput[info.length] = 1;
        byte[] first = hmac(prk, firstInput);
        ByteBuffer secondInput = ByteBuffer.allocate(32 + info.length + 1);
        secondInput.put(first).put(info).put((byte) 2);
        outgoing = new SecretKeySpec(first, "AES");
        incoming = new SecretKeySpec(hmac(prk, secondInput.array()), "AES");
        Arrays.fill(prk, (byte) 0);
    }

    private static byte[] coordinate(BigInteger number) {
        byte[] bytes = number.toByteArray();
        byte[] result = new byte[32];
        int count = Math.min(bytes.length, 32);
        System.arraycopy(bytes, bytes.length - count, result, 32 - count, count);
        return result;
    }

    private static byte[] hmac(byte[] key, byte[] data) throws Exception {
        Mac mac = Mac.getInstance("HmacSHA256");
        mac.init(new SecretKeySpec(key, "HmacSHA256"));
        return mac.doFinal(data);
    }

    synchronized byte[] encrypt(byte[] plaintext) throws Exception {
        if (plaintext.length > 65536 || sent == Long.MAX_VALUE) throw new IllegalArgumentException("Frame limit");
        byte[] iv = ByteBuffer.allocate(12).put(prefix).putLong(++sent).array();
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, outgoing, new GCMParameterSpec(128, iv));
        byte[] ciphertext = cipher.doFinal(plaintext);
        return ByteBuffer.allocate(13 + ciphertext.length).put((byte) 1).put(iv).put(ciphertext).array();
    }

    synchronized byte[] decrypt(byte[] frame) throws Exception {
        if (frame.length < 29 || frame.length > 65565 || frame[0] != 1) throw new IllegalArgumentException("Invalid frame");
        long counter = ByteBuffer.wrap(frame, 5, 8).getLong();
        if (counter <= received) throw new IllegalArgumentException("Replayed frame");
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, incoming, new GCMParameterSpec(128, Arrays.copyOfRange(frame, 1, 13)));
        byte[] plaintext = cipher.doFinal(frame, 13, frame.length - 13);
        received = counter;
        return plaintext;
    }
}
