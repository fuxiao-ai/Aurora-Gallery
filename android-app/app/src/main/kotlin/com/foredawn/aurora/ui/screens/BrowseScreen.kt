package com.foredawn.aurora.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.lazy.grid.rememberLazyGridState
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.List
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.window.layout.WindowMetricsCalculator
import coil.compose.AsyncImage
import coil.request.ImageRequest
import com.foredawn.aurora.data.model.DateGroup
import com.foredawn.aurora.data.model.Folder
import com.foredawn.aurora.data.model.Photo
import com.foredawn.aurora.data.model.Stats
import com.foredawn.aurora.ui.viewmodel.BrowseViewModel
import com.foredawn.aurora.ui.viewmodel.ViewState

enum class NavTab { All, Folders, Dates, Favorites }

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun BrowseScreen(
    baseUrl: String,
    viewModel: BrowseViewModel,
    onPhotoClick: (Photo) -> Unit,
    onSettingsClick: () -> Unit
) {
    var selectedTab by remember { mutableStateOf(NavTab.All) }
    var showSearch by remember { mutableStateOf(false) }
    var searchQuery by remember { mutableStateOf("") }

    val context = LocalContext.current
    val windowMetrics = remember { WindowMetricsCalculator.getOrCreate().computeCurrentWindowMetrics(context) }
    val widthDp = windowMetrics.bounds.width() / context.resources.displayMetrics.density
    val isCompact = widthDp < 600

    val photos = viewModel.photos
    val gridState = rememberLazyGridState()

    LaunchedEffect(Unit) {
        viewModel.initialize()
    }

    // Auto load more when reaching end
    val shouldLoadMore by remember {
        derivedStateOf {
            val layoutInfo = gridState.layoutInfo
            val totalItems = layoutInfo.totalItemsCount
            val lastVisibleItem = layoutInfo.visibleItemsInfo.lastOrNull()?.index ?: 0
            totalItems > 0 && lastVisibleItem >= totalItems - 10
        }
    }

    LaunchedEffect(shouldLoadMore) {
        if (shouldLoadMore && viewModel.hasMore && viewModel.viewState !is ViewState.Loading) {
            viewModel.loadPhotos()
        }
    }

    if (isCompact) {
        // Phone layout: bottom nav
        Scaffold(
            topBar = {
                CenterAlignedTopAppBar(
                    title = { Text("拂晓图库") },
                    actions = {
                        IconButton(onClick = { showSearch = !showSearch }) {
                            Icon(Icons.Default.Search, contentDescription = "搜索")
                        }
                        IconButton(onClick = onSettingsClick) {
                            Icon(Icons.Default.Settings, contentDescription = "设置")
                        }
                    },
                    colors = TopAppBarDefaults.centerAlignedTopAppBarColors(
                        containerColor = MaterialTheme.colorScheme.background.copy(alpha = 0.95f)
                    )
                )
            },
            bottomBar = {
                NavigationBar {
                    NavigationBarItem(
                        selected = selectedTab == NavTab.All,
                        onClick = { selectedTab = NavTab.All; viewModel.setView("all") },
                        icon = { Icon(Icons.Default.PhotoLibrary, null) },
                        label = { Text("全部") }
                    )
                    NavigationBarItem(
                        selected = selectedTab == NavTab.Folders,
                        onClick = { selectedTab = NavTab.Folders },
                        icon = { Icon(Icons.Default.Folder, null) },
                        label = { Text("文件夹") }
                    )
                    NavigationBarItem(
                        selected = selectedTab == NavTab.Dates,
                        onClick = { selectedTab = NavTab.Dates },
                        icon = { Icon(Icons.Default.CalendarMonth, null) },
                        label = { Text("日期") }
                    )
                    NavigationBarItem(
                        selected = selectedTab == NavTab.Favorites,
                        onClick = { selectedTab = NavTab.Favorites; viewModel.setView("favorite") },
                        icon = { Icon(Icons.Default.Favorite, null) },
                        label = { Text("收藏") }
                    )
                }
            }
        ) { padding ->
            Column(modifier = Modifier.padding(padding)) {
                if (showSearch) {
                    OutlinedTextField(
                        value = searchQuery,
                        onValueChange = { searchQuery = it },
                        placeholder = { Text("搜索图片...") },
                        leadingIcon = { Icon(Icons.Default.Search, null) },
                        trailingIcon = {
                            if (searchQuery.isNotEmpty()) {
                                IconButton(onClick = {
                                    searchQuery = ""
                                    viewModel.setView("all")
                                }) {
                                    Icon(Icons.Default.Clear, null)
                                }
                            }
                        },
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(12.dp),
                        singleLine = true,
                        shape = RoundedCornerShape(28.dp)
                    )
                    LaunchedEffect(searchQuery) {
                        if (searchQuery.length >= 2) {
                            viewModel.setView("search", query = searchQuery)
                        } else if (searchQuery.isEmpty()) {
                            viewModel.setView("all")
                        }
                    }
                }
                StatsBar(viewModel.stats)
                Box(modifier = Modifier.fillMaxSize()) {
                    when (selectedTab) {
                        NavTab.Folders -> FolderList(
                            folders = viewModel.folders,
                            onFolderClick = { selectedTab = NavTab.All; viewModel.setView("folder", path = it.path) }
                        )
                        NavTab.Dates -> DateList(
                            dates = viewModel.dateGroups,
                            onDateClick = { selectedTab = NavTab.All; viewModel.setView("date", date = it.date) }
                        )
                        else -> PhotoGrid(
                            photos = photos,
                            baseUrl = baseUrl,
                            gridState = gridState,
                            onPhotoClick = onPhotoClick
                        )
                    }
                    if (viewModel.viewState is ViewState.Loading && photos.isEmpty()) {
                        CircularProgressIndicator(modifier = Modifier.align(Alignment.Center))
                    }
                }
            }
        }
    } else {
        // Tablet layout: side nav + content
        PermanentNavigationDrawer(
            drawerContent = {
                PermanentDrawerSheet(modifier = Modifier.width(280.dp)) {
                    Column(modifier = Modifier.padding(16.dp)) {
                        Text(
                            "拂晓图库",
                            style = MaterialTheme.typography.headlineSmall,
                            color = MaterialTheme.colorScheme.primary
                        )
                        Spacer(modifier = Modifier.height(16.dp))
                        NavigationDrawerItem(
                            label = { Text("所有文件") },
                            selected = selectedTab == NavTab.All,
                            onClick = { selectedTab = NavTab.All; viewModel.setView("all") },
                            icon = { Icon(Icons.Default.PhotoLibrary, null) }
                        )
                        NavigationDrawerItem(
                            label = { Text("文件夹") },
                            selected = selectedTab == NavTab.Folders,
                            onClick = { selectedTab = NavTab.Folders },
                            icon = { Icon(Icons.Default.Folder, null) }
                        )
                        NavigationDrawerItem(
                            label = { Text("日期") },
                            selected = selectedTab == NavTab.Dates,
                            onClick = { selectedTab = NavTab.Dates },
                            icon = { Icon(Icons.Default.CalendarMonth, null) }
                        )
                        NavigationDrawerItem(
                            label = { Text("收藏") },
                            selected = selectedTab == NavTab.Favorites,
                            onClick = { selectedTab = NavTab.Favorites; viewModel.setView("favorite") },
                            icon = { Icon(Icons.Default.Favorite, null) }
                        )
                        Spacer(modifier = Modifier.height(8.dp))
                        HorizontalDivider()
                        Spacer(modifier = Modifier.height(8.dp))
                        NavigationDrawerItem(
                            label = { Text("搜索") },
                            selected = showSearch,
                            onClick = { showSearch = !showSearch },
                            icon = { Icon(Icons.Default.Search, null) }
                        )
                        NavigationDrawerItem(
                            label = { Text("设置") },
                            selected = false,
                            onClick = onSettingsClick,
                            icon = { Icon(Icons.Default.Settings, null) }
                        )
                    }
                }
            }
        ) {
            Column(modifier = Modifier.fillMaxSize()) {
                if (showSearch) {
                    OutlinedTextField(
                        value = searchQuery,
                        onValueChange = { searchQuery = it },
                        placeholder = { Text("搜索图片...") },
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(16.dp),
                        singleLine = true
                    )
                    LaunchedEffect(searchQuery) {
                        if (searchQuery.length >= 2) {
                            viewModel.setView("search", query = searchQuery)
                        } else if (searchQuery.isEmpty()) {
                            viewModel.setView("all")
                        }
                    }
                }
                StatsBar(viewModel.stats)
                Box(modifier = Modifier.fillMaxSize()) {
                    when (selectedTab) {
                        NavTab.Folders -> FolderList(
                            folders = viewModel.folders,
                            onFolderClick = { selectedTab = NavTab.All; viewModel.setView("folder", path = it.path) }
                        )
                        NavTab.Dates -> DateList(
                            dates = viewModel.dateGroups,
                            onDateClick = { selectedTab = NavTab.All; viewModel.setView("date", date = it.date) }
                        )
                        else -> PhotoGrid(
                            photos = photos,
                            baseUrl = baseUrl,
                            gridState = gridState,
                            onPhotoClick = onPhotoClick
                        )
                    }
                    if (viewModel.viewState is ViewState.Loading && photos.isEmpty()) {
                        CircularProgressIndicator(modifier = Modifier.align(Alignment.Center))
                    }
                }
            }
        }
    }
}

@Composable
fun StatsBar(stats: Stats?) {
    stats?.let {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 12.dp, vertical = 6.dp),
            horizontalArrangement = Arrangement.spacedBy(12.dp)
        ) {
            AssistChip(
                onClick = {},
                label = { Text("${it.totalPhotos} 张") },
                leadingIcon = { Icon(Icons.Default.PhotoLibrary, null, modifier = Modifier.size(16.dp)) }
            )
            if (it.videoPhotos > 0) {
                AssistChip(
                    onClick = {},
                    label = { Text("${it.videoPhotos} 视频") },
                    leadingIcon = { Icon(Icons.Default.Videocam, null, modifier = Modifier.size(16.dp)) }
                )
            }
            if (it.favoritePhotos > 0) {
                AssistChip(
                    onClick = {},
                    label = { Text("${it.favoritePhotos} 收藏") },
                    leadingIcon = { Icon(Icons.Default.Favorite, null, modifier = Modifier.size(16.dp)) }
                )
            }
        }
    }
}

@Composable
fun PhotoGrid(
    photos: List<Photo>,
    baseUrl: String,
    gridState: androidx.compose.foundation.lazy.grid.LazyGridState,
    onPhotoClick: (Photo) -> Unit
) {
    LazyVerticalGrid(
        columns = GridCells.Adaptive(minSize = 140.dp),
        state = gridState,
        contentPadding = PaddingValues(8.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
        modifier = Modifier.fillMaxSize()
    ) {
        items(photos, key = { it.id }) { photo ->
            PhotoCard(photo = photo, baseUrl = baseUrl, onClick = { onPhotoClick(photo) })
        }
    }
}

@Composable
fun PhotoCard(photo: Photo, baseUrl: String, onClick: () -> Unit) {
    Box(
        modifier = Modifier
            .aspectRatio(1f)
            .clip(RoundedCornerShape(12.dp))
            .background(MaterialTheme.colorScheme.surfaceVariant)
            .clickable { onClick() }
    ) {
        AsyncImage(
            model = ImageRequest.Builder(LocalContext.current)
                .data(photo.thumbnailUrl(baseUrl))
                .crossfade(true)
                .build(),
            contentDescription = photo.fileName,
            contentScale = ContentScale.Crop,
            modifier = Modifier.fillMaxSize()
        )
        if (photo.isVideo()) {
            Box(
                modifier = Modifier
                    .align(Alignment.Center)
                    .size(32.dp)
                    .background(
                        MaterialTheme.colorScheme.surface.copy(alpha = 0.7f),
                        RoundedCornerShape(50)
                    ),
                contentAlignment = Alignment.Center
            ) {
                Icon(
                    imageVector = Icons.Default.PlayArrow,
                    contentDescription = null,
                    tint = MaterialTheme.colorScheme.onSurface
                )
            }
        }
        if (photo.isFavorite == 1) {
            Icon(
                imageVector = Icons.Default.Favorite,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.primary,
                modifier = Modifier
                    .align(Alignment.TopEnd)
                    .padding(6.dp)
                    .size(18.dp)
            )
        }
    }
}

@Composable
fun FolderList(folders: List<Folder>, onFolderClick: (Folder) -> Unit) {
    LazyColumn(contentPadding = PaddingValues(12.dp)) {
        items(folders) { folder ->
            ListItem(
                headlineContent = { Text(folder.name) },
                supportingContent = { Text("${folder.photoCount} 张图片") },
                leadingContent = { Icon(Icons.Default.Folder, null) },
                modifier = Modifier.clickable { onFolderClick(folder) }
            )
            HorizontalDivider()
        }
    }
}

@Composable
fun DateList(dates: List<DateGroup>, onDateClick: (DateGroup) -> Unit) {
    LazyColumn(contentPadding = PaddingValues(12.dp)) {
        items(dates) { date ->
            ListItem(
                headlineContent = { Text(date.date) },
                supportingContent = { Text("${date.count} 张图片") },
                leadingContent = { Icon(Icons.Default.CalendarToday, null) },
                modifier = Modifier.clickable { onDateClick(date) }
            )
            HorizontalDivider()
        }
    }
}
