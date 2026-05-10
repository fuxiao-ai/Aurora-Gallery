package com.foredawn.aurora.ui.viewmodel

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.foredawn.aurora.data.model.*
import com.foredawn.aurora.data.repository.PhotoRepository
import kotlinx.coroutines.launch

sealed class ViewState {
    data object Idle : ViewState()
    data object Loading : ViewState()
    data class Error(val message: String) : ViewState()
    data object Success : ViewState()
}

class BrowseViewModel(private val repository: PhotoRepository) : ViewModel() {
    var viewState by mutableStateOf<ViewState>(ViewState.Idle)
        private set

    var stats by mutableStateOf<Stats?>(null)
        private set

    val photos = mutableStateListOf<Photo>()
    var currentPage by mutableIntStateOf(1)
        private set
    var totalPages by mutableIntStateOf(1)
        private set
    var hasMore by mutableStateOf(true)
        private set

    var currentView by mutableStateOf("all") // all, folder, date, search, favorite
        private set
    var currentPath by mutableStateOf("")
        private set
    var currentDate by mutableStateOf("")
        private set
    var searchQuery by mutableStateOf("")
        private set

    var folders by mutableStateOf<List<Folder>>(emptyList())
        private set
    var dateGroups by mutableStateOf<List<DateGroup>>(emptyList())
        private set

    var selectedPhoto by mutableStateOf<Photo?>(null)
    var photoInfo by mutableStateOf<PhotoInfo?>(null)

    fun initialize() {
        if (photos.isEmpty() && viewState == ViewState.Idle) {
            loadStats()
            loadRootFolders()
            loadDateGroups()
            loadPhotos()
        }
    }

    fun loadStats() {
        viewModelScope.launch {
            repository.getStats().onSuccess { stats = it }.onFailure { /* ignore */ }
        }
    }

    fun loadRootFolders() {
        viewModelScope.launch {
            repository.getRootFolders().onSuccess { folders = it }
        }
    }

    fun loadDateGroups() {
        viewModelScope.launch {
            repository.getDateGroups().onSuccess { dateGroups = it }
        }
    }

    fun loadPhotos(refresh: Boolean = false) {
        if (refresh) {
            currentPage = 1
            photos.clear()
            hasMore = true
        }
        if (!hasMore && !refresh) return

        viewModelScope.launch {
            viewState = if (photos.isEmpty()) ViewState.Loading else ViewState.Success
            val isFavorites = currentView == "favorite"
            val result = when (currentView) {
                "folder" -> repository.getFolderPhotos(currentPath, currentPage, favoritesOnly = isFavorites)
                "date" -> repository.getDatePhotos(currentDate, currentPage, favoritesOnly = isFavorites)
                "search" -> repository.search(searchQuery, currentPage, favoritesOnly = isFavorites)
                else -> repository.getPhotos(currentPage, favoritesOnly = isFavorites)
            }
            result.onSuccess { data ->
                if (refresh) photos.clear()
                photos.addAll(data.photos)
                totalPages = data.totalPages
                hasMore = currentPage < data.totalPages
                currentPage++
                viewState = ViewState.Success
            }.onFailure {
                viewState = ViewState.Error(it.message ?: "加载失败")
            }
        }
    }

    fun setView(view: String, path: String = "", date: String = "", query: String = "") {
        currentView = view
        currentPath = path
        currentDate = date
        searchQuery = query
        loadPhotos(refresh = true)
    }

    fun refresh() = loadPhotos(refresh = true)

    fun toggleFavorite(photo: Photo, onResult: (Boolean) -> Unit) {
        viewModelScope.launch {
            repository.toggleFavorite(photo.id).onSuccess { onResult(it) }.onFailure { onResult(false) }
        }
    }

    fun loadPhotoInfo(id: Long) {
        viewModelScope.launch {
            repository.getPhotoInfo(id).onSuccess { photoInfo = it }
        }
    }

    fun getVideoPlayback(id: Long, onResult: (VideoPlayback?) -> Unit) {
        viewModelScope.launch {
            repository.getVideoPlayback(id).onSuccess { onResult(it) }.onFailure { onResult(null) }
        }
    }
}
