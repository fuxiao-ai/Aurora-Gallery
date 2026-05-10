package com.foredawn.aurora.ui.screens

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Link
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch

@Composable
fun ServerSetupScreen(
    currentUrl: String?,
    onSave: suspend (String) -> Boolean,
    onTestSuccess: (String) -> Unit
) {
    var url by remember { mutableStateOf(currentUrl ?: "") }
    var isLoading by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()

    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(24.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center
    ) {
        Icon(
            imageVector = Icons.Default.Link,
            contentDescription = null,
            modifier = Modifier.size(64.dp),
            tint = MaterialTheme.colorScheme.primary
        )
        Spacer(modifier = Modifier.height(16.dp))
        Text(
            text = "连接服务器",
            style = MaterialTheme.typography.headlineMedium,
            color = MaterialTheme.colorScheme.onBackground
        )
        Spacer(modifier = Modifier.height(8.dp))
        Text(
            text = "输入拂晓图库的局域网地址",
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant
        )
        Spacer(modifier = Modifier.height(24.dp))
        OutlinedTextField(
            value = url,
            onValueChange = { error = null; url = it },
            label = { Text("服务器地址") },
            placeholder = { Text("http://192.168.1.5:3456") },
            modifier = Modifier.fillMaxWidth(),
            keyboardOptions = KeyboardOptions(
                keyboardType = KeyboardType.Uri,
                imeAction = ImeAction.Done
            ),
            keyboardActions = KeyboardActions(onDone = {
                scope.launch { testConnection() }
            }),
            isError = error != null,
            supportingText = error?.let { { Text(it) } }
        )
        Spacer(modifier = Modifier.height(16.dp))
        Button(
            onClick = {
                scope.launch { testConnection() }
            },
            modifier = Modifier.fillMaxWidth(),
            enabled = url.isNotBlank() && !isLoading
        ) {
            if (isLoading) {
                CircularProgressIndicator(modifier = Modifier.size(20.dp), strokeWidth = 2.dp)
                Spacer(modifier = Modifier.width(8.dp))
            }
            Text("连接")
        }
    }

    suspend fun testConnection() {
        isLoading = true
        error = null
        val fixedUrl = url.trim().removeSuffix("/") + "/"
        val success = onSave(fixedUrl)
        if (success) {
            onTestSuccess(fixedUrl)
        } else {
            error = "无法连接到服务器，请检查地址和网络"
        }
        isLoading = false
    }
}
