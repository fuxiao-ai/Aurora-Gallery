package com.foredawn.aurora.data.local

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map

val Context.dataStore: DataStore<Preferences> by preferencesDataStore(name = "settings")

object SettingsKeys {
    val SERVER_URL = stringPreferencesKey("server_url")
}

class SettingsStore(private val context: Context) {
    val serverUrl: Flow<String?> = context.dataStore.data.map { prefs ->
        prefs[SettingsKeys.SERVER_URL]
    }

    suspend fun saveServerUrl(url: String) {
        context.dataStore.edit { prefs ->
            prefs[SettingsKeys.SERVER_URL] = url
        }
    }

    suspend fun clear() {
        context.dataStore.edit { it.clear() }
    }
}
