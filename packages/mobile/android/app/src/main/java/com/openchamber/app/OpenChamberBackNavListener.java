package com.openchamber.app;

/** Framework-free listener shared by API 33/34 back-nav support classes. */
interface OpenChamberBackNavListener {
    void onBackStarted(float progress);

    void onBackProgressed(float progress);

    void onBackCancelled();

    void onBackInvoked();
}
