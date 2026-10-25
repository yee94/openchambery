package com.yuri.app;

import android.window.BackEvent;
import android.window.OnBackAnimationCallback;

/**
 * API 34+ Predictive Back animation callback.
 *
 * Isolated so Android &lt; 14 never class-loads {@link OnBackAnimationCallback}
 * / {@link BackEvent} while resolving {@link YuriNavigationPlugin}.
 */
final class YuriBackAnimationSupport {
    private YuriBackAnimationSupport() {}

    static Object create(YuriBackNavListener listener) {
        return new OnBackAnimationCallback() {
            @Override
            public void onBackStarted(BackEvent backEvent) {
                listener.onBackStarted(backEvent.getProgress());
            }

            @Override
            public void onBackProgressed(BackEvent backEvent) {
                listener.onBackProgressed(backEvent.getProgress());
            }

            @Override
            public void onBackCancelled() {
                listener.onBackCancelled();
            }

            @Override
            public void onBackInvoked() {
                listener.onBackInvoked();
            }
        };
    }
}
