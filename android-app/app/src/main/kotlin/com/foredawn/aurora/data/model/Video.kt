package com.foredawn.aurora.data.model

import com.google.gson.annotations.SerializedName

data class VideoPlayback(
    val ready: Boolean,
    val mode: String, // "progressive" | "hls"
    val url: String?,
    @SerializedName("playlistUrl") val playlistUrl: String?,
    @SerializedName("sessionId") val sessionId: String?,
    val tier: String?,
    val error: String?,
    val message: String?
)

data class SubtitleStreams(
    val tracks: List<SubtitleTrack>,
    @SerializedName("hasExternal") val hasExternal: Boolean
)

data class SubtitleTrack(
    val index: Int,
    val language: String?,
    val title: String?,
    val codec: String?
)
