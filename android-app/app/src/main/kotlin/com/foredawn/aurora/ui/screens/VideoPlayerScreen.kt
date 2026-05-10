package com.foredawn.aurora.ui.screens

import android.view.ViewGroup
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.media3.common.MediaItem
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.hls.HlsMediaSource
import androidx.media3.datasource.DefaultDataSource
import androidx.media3.ui.PlayerView
import com.foredawn.aurora.data.model.Photo
import com.foredawn.aurora.ui.viewmodel.BrowseViewModel

@androidx.annotation.OptIn(UnstableApi::class)
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun VideoPlayerScreen(
    baseUrl: String,
    photo: Photo,
    viewModel: BrowseViewModel,
    onBack: () -> Unit
) {
    val context = LocalContext.current
    var playback by remember { mutableStateOf<com.foredawn.aurora.data.model.VideoPlayback?>(null) }
    var isLoading by remember { mutableStateOf(true) }
    var error by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(photo.id) {
        viewModel.getVideoPlayback(photo.id) { result ->
            isLoading = false
            if (result != null && result.ready) {
                playback = result
            } else {
                error = result?.message ?: result?.error ?: "无法播放视频"
            }
        }
    }

    val exoPlayer = remember(playback) {
        playback?.let { pb ->
            ExoPlayer.Builder(context).build().apply {
                val dataSourceFactory = DefaultDataSource.Factory(context)
                val mediaSource = when {
                    pb.mode == "hls" && pb.playlistUrl != null -> {
                        val uri = if (pb.playlistUrl.startsWith("http")) pb.playlistUrl else baseUrl.removeSuffix("/") + pb.playlistUrl
                        HlsMediaSource.Factory(dataSourceFactory).createMediaSource(MediaItem.fromUri(uri))
                    }
                    pb.url != null -> {
                        val uri = if (pb.url.startsWith("http")) pb.url else baseUrl.removeSuffix("/") + pb.url
                        androidx.media3.exoplayer.source.ProgressiveMediaSource.Factory(dataSourceFactory)
                            .createMediaSource(MediaItem.fromUri(uri))
                    }
                    else -> null
                }
                mediaSource?.let { setMediaSource(it) }
                playWhenReady = true
                prepare()
            }
        }
    }

    val lifecycleOwner = LocalLifecycleOwner.current
    DisposableEffect(lifecycleOwner) {
        val observer = LifecycleEventObserver { _, event ->
            when (event) {
                Lifecycle.Event.ON_PAUSE -> exoPlayer?.pause()
                Lifecycle.Event.ON_RESUME -> exoPlayer?.play()
                Lifecycle.Event.ON_DESTROY -> exoPlayer?.release()
                else -> {}
            }
        }
        lifecycleOwner.lifecycle.addObserver(observer)
        onDispose {
            lifecycleOwner.lifecycle.removeObserver(observer)
            exoPlayer?.release()
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(photo.fileName, maxLines = 1) },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, null)
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = MaterialTheme.colorScheme.background.copy(alpha = 0.9f)
                )
            )
        }
    ) { padding ->
        Box(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .background(MaterialTheme.colorScheme.background)
        ) {
            when {
                isLoading -> CircularProgressIndicator(modifier = Modifier.align(Alignment.Center))
                error != null -> Text(
                    error ?: "播放失败",
                    modifier = Modifier.align(Alignment.Center),
                    color = MaterialTheme.colorScheme.error
                )
                exoPlayer != null -> {
                    AndroidView(
                        factory = {
                            PlayerView(context).apply {
                                player = exoPlayer
                                layoutParams = ViewGroup.LayoutParams(
                                    ViewGroup.LayoutParams.MATCH_PARENT,
                                    ViewGroup.LayoutParams.MATCH_PARENT
                                )
                                useController = true
                            }
                        },
                        modifier = Modifier.fillMaxSize()
                    )
                }
            }
        }
    }
}
