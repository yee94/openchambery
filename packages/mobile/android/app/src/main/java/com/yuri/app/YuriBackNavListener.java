package com.yuri.app;

/** Framework-free listener shared by API 33/34 back-nav support classes. */
interface YuriBackNavListener {
    void onBackStarted(float progress);

    void onBackProgressed(float progress);

    void onBackCancelled();

    void onBackInvoked();
}
