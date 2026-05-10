package com.foredawn.aurora

import android.app.Application
import com.foredawn.aurora.data.local.SettingsStore

class AuroraApplication : Application() {
    lateinit var settingsStore: SettingsStore
        private set

    override fun onCreate() {
        super.onCreate()
        settingsStore = SettingsStore(this)
    }
}
