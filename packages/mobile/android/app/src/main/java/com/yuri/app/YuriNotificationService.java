package com.yuri.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.SystemClock;
import androidx.core.app.NotificationCompat;
import java.util.concurrent.TimeUnit;
import okhttp3.OkHttpClient;
import org.json.JSONObject;

/** User-enabled, notification-only foreground service. Credentials live only in process memory. */
public class YuriNotificationService extends Service {
    static JSONObject requested;
    static boolean appVisible;
    private static final String CONNECTION_CHANNEL = "yuri-background-connection";
    private static final String ALERT_CHANNEL = "yuri-task-alerts";
    private static final int SERVICE_ID = 91730;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final NotificationReconnect backoff = new NotificationReconnect();
    private OkHttpClient client;
    private NotificationConnection connection;
    private ConnectivityManager connectivity;
    private JSONObject config;
    private String cursor = "";
    private String state = "connecting";
    private long readyAt;
    private int generation;
    private boolean useRelay;
    private boolean destroyed;
    private boolean networkRegistered;
    private final Runnable reconnect = this::connect;
    private final Runnable watchdog = new Runnable() {
        @Override public void run() {
            if (destroyed) return;
            if (connection != null && SystemClock.elapsedRealtime() - connection.lastReceived > 90_000) failed(NotificationFailure.NETWORK);
            main.postDelayed(this, 30_000);
        }
    };
    private final ConnectivityManager.NetworkCallback networkCallback = new ConnectivityManager.NetworkCallback() {
        @Override public void onAvailable(Network network) {
            main.post(() -> { if (!destroyed && connection == null) { main.removeCallbacks(reconnect); connect(); } });
        }
        @Override public void onLost(Network network) {
            main.post(() -> { if (!destroyed && !online()) failed(NotificationFailure.NETWORK); });
        }
    };

    @Override public void onCreate() {
        super.onCreate();
        client = new OkHttpClient.Builder().connectTimeout(10, TimeUnit.SECONDS)
            .readTimeout(90, TimeUnit.SECONDS).writeTimeout(15, TimeUnit.SECONDS)
            .followRedirects(false).followSslRedirects(false).retryOnConnectionFailure(false).build();
        connectivity = (ConnectivityManager) getSystemService(CONNECTIVITY_SERVICE);
        try { connectivity.registerDefaultNetworkCallback(networkCallback); networkRegistered = true; }
        catch (RuntimeException ignored) { /* Timed reconnect remains available. */ }
        main.postDelayed(watchdog, 30_000);
    }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        JSONObject next = requested;
        if (next == null) { stopSelf(); return START_NOT_STICKY; }
        boolean changed = config == null || !config.toString().equals(next.toString());
        if (changed) {
            cancelConnection();
            clearAlerts();
            config = next;
            cursor = "";
            useRelay = config.optBoolean("preferRelay");
            state = "connecting";
        }
        createChannels();
        Notification notification = connectionNotification();
        if (Build.VERSION.SDK_INT >= 34) startForeground(SERVICE_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
        else startForeground(SERVICE_ID, notification);
        if (changed) connect();
        return START_NOT_STICKY;
    }

    private String text(String key) { return config.optJSONObject("labels").optString(key, "Yuri"); }
    private NotificationManager notifications() { return (NotificationManager) getSystemService(NOTIFICATION_SERVICE); }
    private void createChannels() {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationChannel ongoing = new NotificationChannel(CONNECTION_CHANNEL, text("service"), NotificationManager.IMPORTANCE_LOW);
        ongoing.setSound(null, null);
        ongoing.enableVibration(false);
        ongoing.setShowBadge(false);
        notifications().createNotificationChannel(ongoing);
        notifications().createNotificationChannel(new NotificationChannel(ALERT_CHANNEL, text("alerts"), NotificationManager.IMPORTANCE_HIGH));
    }
    private PendingIntent openApp(Uri uri, int id) {
        Intent intent = new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        if (uri != null) intent.setAction(Intent.ACTION_VIEW).setData(uri);
        return PendingIntent.getActivity(this, id, intent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }
    private Notification connectionNotification() {
        return new NotificationCompat.Builder(this, CONNECTION_CHANNEL).setSmallIcon(R.drawable.ic_stat_notify)
            .setContentTitle(text("service")).setContentText(text(state)).setOngoing(true).setOnlyAlertOnce(true)
            .setSilent(true).setShowWhen(false).setContentIntent(openApp(null, SERVICE_ID)).build();
    }
    private void setState(String next) {
        if (state.equals(next)) return;
        state = next;
        notifications().notify(SERVICE_ID, connectionNotification());
    }
    private boolean online() {
        Network network = connectivity.getActiveNetwork();
        NetworkCapabilities capabilities = network == null ? null : connectivity.getNetworkCapabilities(network);
        return capabilities != null && capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET);
    }
    private void cancelConnection() {
        generation++;
        main.removeCallbacks(reconnect);
        if (connection != null) connection.close();
        connection = null;
        readyAt = 0;
    }
    private void connect() {
        if (destroyed || config == null || requested == null) return;
        cancelConnection();
        if (!online()) { setState("reconnecting"); main.postDelayed(reconnect, 300_000); return; }
        int attempt = generation;
        try {
            connection = new NotificationConnection(client, config, useRelay, cursor, new NotificationConnection.Listener() {
                @Override public void event(String id, JSONObject event) {
                    main.post(() -> {
                        if (destroyed || attempt != generation) return;
                        try {
                            String type = event.optString("type");
                            if (type.equals("ready")) {
                                readyAt = SystemClock.elapsedRealtime();
                                setState("connected");
                                if (event.optBoolean("gap")) showAlert(new JSONObject().put("title", text("service")).put("body", text("gap")).put("tag", "gap"), id);
                            } else if (type.equals("notification") && !id.equals(cursor)) {
                                if (!event.optBoolean("requireHidden") || !appVisible) showAlert(event, id);
                            } else return;
                            cursor = id;
                        } catch (Exception ignored) { failed(NotificationFailure.INITIALIZATION); }
                    });
                }
                @Override public void failed(NotificationFailure failure) {
                    main.post(() -> { if (!destroyed && attempt == generation) YuriNotificationService.this.failed(failure); });
                }
            });
        } catch (Exception ignored) { failed(NotificationFailure.INITIALIZATION); }
    }
    private void failed(NotificationFailure failure) {
        if (destroyed || config == null) return;
        long healthyMillis = readyAt == 0 ? 0 : SystemClock.elapsedRealtime() - readyAt;
        cancelConnection();
        setState(failure.label);
        long delay = backoff.failed(failure.permanent, healthyMillis);
        // A known paired relay remains reachable when the phone leaves the LAN.
        if (!useRelay && config != null && config.optJSONObject("relay") != null) { useRelay = true; delay = 0; }
        // Small jitter avoids synchronized retries across devices. No wake locks or alarms.
        main.postDelayed(reconnect, delay == 0 ? 0 : delay + (long) (Math.random() * delay * 0.2));
    }
    private void showAlert(JSONObject event, String id) {
        String tag = "yuri-native:" + event.optString("tag", id);
        Uri.Builder link = new Uri.Builder().scheme("yuri");
        if (!event.optString("assistantID").isEmpty()) link.authority("assistant").appendPath(event.optString("assistantID"));
        else if (!event.optString("sessionId").isEmpty()) {
            link.authority("session").appendPath(event.optString("sessionId"));
            if (!event.optString("directory").isEmpty()) link.appendQueryParameter("directory", event.optString("directory"));
        } else link.authority("sessions");
        int notificationId = tag.hashCode();
        Notification notification = new NotificationCompat.Builder(this, ALERT_CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_notify).setContentTitle("error".equals(event.optString("kind")) ? text("error") : event.optString("title", "Yuri"))
            .setContentText(event.optString("body")).setStyle(new NotificationCompat.BigTextStyle().bigText(event.optString("body")))
            .setAutoCancel(true).setContentIntent(openApp(link.build(), notificationId)).build();
        notifications().notify(tag, notificationId, notification);
    }
    private void clearAlerts() {
        for (android.service.notification.StatusBarNotification notification : notifications().getActiveNotifications()) {
            if (notification.getTag() != null && notification.getTag().startsWith("yuri-native:")) {
                notifications().cancel(notification.getTag(), notification.getId());
            }
        }
    }
    @Override public void onDestroy() {
        destroyed = true;
        cancelConnection();
        main.removeCallbacksAndMessages(null);
        if (networkRegistered) connectivity.unregisterNetworkCallback(networkCallback);
        client.dispatcher().cancelAll();
        client.connectionPool().evictAll();
        client.dispatcher().executorService().shutdown();
        clearAlerts();
        config = null;
        stopForeground(STOP_FOREGROUND_REMOVE);
        super.onDestroy();
    }
    @Override public IBinder onBind(Intent intent) { return null; }
}
