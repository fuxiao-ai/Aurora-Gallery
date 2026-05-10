package com.foredawn.aurora.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import coil.compose.AsyncImage
import coil.request.ImageRequest
import com.foredawn.aurora.data.model.Photo
import com.foredawn.aurora.ui.viewmodel.BrowseViewModel

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PhotoPreviewScreen(
    baseUrl: String,
    photos: List<Photo>,
    initialIndex: Int,
    viewModel: BrowseViewModel,
    onBack: () -> Unit,
    onVideoClick: (Photo) -> Unit
) {
    val pagerState = rememberPagerState(initialPage = initialIndex, pageCount = { photos.size })
    var showUi by remember { mutableStateOf(true) }
    var scale by remember { mutableFloatStateOf(1f) }
    var offsetX by remember { mutableFloatStateOf(0f) }
    var offsetY by remember { mutableFloatStateOf(0f) }

    val currentPhoto = photos.getOrNull(pagerState.currentPage)

    LaunchedEffect(pagerState.currentPage) {
        scale = 1f
        offsetX = 0f
        offsetY = 0f
        currentPhoto?.let { viewModel.loadPhotoInfo(it.id) }
    }

    Scaffold(
        topBar = {
            if (showUi) {
                TopAppBar(
                    title = {
                        Text(
                            currentPhoto?.fileName ?: "",
                            maxLines = 1,
                            overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis
                        )
                    },
                    navigationIcon = {
                        IconButton(onClick = onBack) {
                            Icon(Icons.AutoMirrored.Filled.ArrowBack, null)
                        }
                    },
                    actions = {
                        currentPhoto?.let { photo ->
                            if (photo.isVideo()) {
                                IconButton(onClick = { onVideoClick(photo) }) {
                                    Icon(Icons.Default.PlayCircle, null)
                                }
                            }
                            IconButton(onClick = {
                                viewModel.toggleFavorite(photo) { success ->
                                    if (success) {
                                        // Update local list if needed
                                    }
                                }
                            }) {
                                Icon(
                                    if (photo.isFavorite == 1) Icons.Default.Favorite else Icons.Default.FavoriteBorder,
                                    null,
                                    tint = if (photo.isFavorite == 1) MaterialTheme.colorScheme.primary else LocalContentColor.current
                                )
                            }
                        }
                    },
                    colors = TopAppBarDefaults.topAppBarColors(
                        containerColor = MaterialTheme.colorScheme.background.copy(alpha = 0.85f)
                    )
                )
            }
        },
        bottomBar = {
            if (showUi) {
                BottomAppBar(
                    containerColor = MaterialTheme.colorScheme.background.copy(alpha = 0.85f)
                ) {
                    viewModel.photoInfo?.let { info ->
                        Column(modifier = Modifier.padding(horizontal = 16.dp)) {
                            Text(
                                "${info.width ?: "?"} x ${info.height ?: "?"}  |  ${formatFileSize(info.fileSize)}",
                                style = MaterialTheme.typography.bodySmall
                            )
                            info.dateTaken?.let { d ->
                                Text(d, style = MaterialTheme.typography.labelSmall)
                            }
                            if (info.cameraMake != null || info.cameraModel != null) {
                                Text(
                                    "${info.cameraMake ?: ""} ${info.cameraModel ?: ""}",
                                    style = MaterialTheme.typography.labelSmall
                                )
                            }
                        }
                    }
                    Spacer(modifier = Modifier.weight(1f))
                    Text(
                        "${pagerState.currentPage + 1} / ${photos.size}",
                        modifier = Modifier.padding(end = 16.dp),
                        style = MaterialTheme.typography.bodyMedium
                    )
                }
            }
        }
    ) { padding ->
        Box(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .background(MaterialTheme.colorScheme.background)
        ) {
            HorizontalPager(
                state = pagerState,
                modifier = Modifier.fillMaxSize()
            ) { page ->
                val photo = photos[page]
                Box(
                    modifier = Modifier.fillMaxSize(),
                    contentAlignment = Alignment.Center
                ) {
                    AsyncImage(
                        model = ImageRequest.Builder(LocalContext.current)
                            .data(photo.previewUrl(baseUrl))
                            .crossfade(true)
                            .build(),
                        contentDescription = photo.fileName,
                        contentScale = ContentScale.Fit,
                        modifier = Modifier
                            .fillMaxSize()
                            .graphicsLayer {
                                scaleX = scale
                                scaleY = scale
                                translationX = offsetX
                                translationY = offsetY
                            }
                            .pointerInput(Unit) {
                                detectTapGestures(
                                    onDoubleTap = {
                                        if (scale > 1f) {
                                            scale = 1f
                                            offsetX = 0f
                                            offsetY = 0f
                                        } else {
                                            scale = 2.5f
                                        }
                                    },
                                    onTap = { showUi = !showUi }
                                )
                            }
                    )
                }
            }
        }
    }
}

fun formatFileSize(size: Long): String {
    return when {
        size >= 1_073_741_824 -> String.format("%.2f GB", size / 1_073_741_824.0)
        size >= 1_048_576 -> String.format("%.2f MB", size / 1_048_576.0)
        size >= 1024 -> String.format("%.2f KB", size / 1024.0)
        else -> "$size B"
    }
}
