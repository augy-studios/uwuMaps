package org.uwuapps.maps

import android.app.PendingIntent
import android.content.ActivityNotFoundException
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInfo
import android.content.pm.PackageInstaller
import android.content.pm.PackageManager
import android.content.res.Resources
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.StatFs
import android.provider.Settings
import android.util.Log
import android.view.WindowManager
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel
import java.io.File
import java.io.FileInputStream
import java.lang.ref.WeakReference
import kotlin.concurrent.thread

/**
 * The app's one screen, and the few things Dart can't do for itself (lib/core/device.dart): naming the
 * phone's font, how much room there is, leaving without closing, and handing an update to Android's
 * installer (lib/update/update_page.dart).
 */
class MainActivity : FlutterActivity() {
    private var channel: MethodChannel? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // Into the camera cutout, rather than a black strip, on phones before Android 15.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            window.attributes = window.attributes.apply {
                layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
            }
        }
        showing = WeakReference(this)
    }

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        channel = MethodChannel(flutterEngine.dartExecutor.binaryMessenger, CHANNEL).apply {
            setMethodCallHandler(::onCall)
        }
    }

    override fun onDestroy() {
        if (showing.get() === this) showing.clear()
        super.onDestroy()
    }

    private fun onCall(call: MethodCall, result: MethodChannel.Result) {
        when (call.method) {
            "bodyFont" -> result.success(bodyFont())
            "freeBytes" -> result.success(StatFs(filesDir.path).availableBytes)
            "moveToBack" -> {
                moveTaskToBack(true)
                result.success(null)
            }
            "canInstall" -> result.success(
                Build.VERSION.SDK_INT < Build.VERSION_CODES.O || packageManager.canRequestPackageInstalls(),
            )
            "autoBlockerPossible" -> result.success(
                "samsung".equals(Build.MANUFACTURER, ignoreCase = true) &&
                    Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE,
            )
            "openInstallSettings" -> {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:$packageName")))
                }
                result.success(null)
            }
            // Samsung publishes no way to open Auto Blocker's own page, so this opens the one above it, or
            // Settings if even that's missing.
            "openSecuritySettings" -> {
                try {
                    startActivity(Intent(Settings.ACTION_SECURITY_SETTINGS))
                } catch (e: ActivityNotFoundException) {
                    startActivity(Intent(Settings.ACTION_SETTINGS))
                }
                result.success(null)
            }
            "archiveInfo" -> {
                val info = packageManager.getPackageArchiveInfo(call.argument<String>("path")!!, 0)
                result.success(info?.let { mapOf("package" to it.packageName, "versionCode" to versionCode(it)) })
            }
            "versionCode" -> result.success(versionCode(packageManager.getPackageInfo(packageName, 0)))
            "installApk" -> {
                val apk = File(call.argument<String>("path")!!)
                thread(name = "update") {
                    try {
                        install(apk)
                        runOnUiThread { result.success(null) }
                    } catch (e: Exception) {
                        Log.w(TAG, e)
                        runOnUiThread {
                            result.success(null)
                            report(mapOf("status" to "failed"))
                        }
                    }
                }
            }
            else -> result.notImplemented()
        }
    }

    // The family Android's own apps use for their text, where the phone names one: a brand's own font
    // from Android 12, such as Google Sans. Flutter falls back to the phone's default without one.
    private fun bodyFont(): String? {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return null
        val id = Resources.getSystem().getIdentifier("config_bodyFontFamily", "string", "android")
        if (id == 0) return null
        return try {
            Resources.getSystem().getString(id).takeIf { it.isNotBlank() }
        } catch (e: Resources.NotFoundException) {
            null
        }
    }

    @Suppress("DEPRECATION")
    private fun versionCode(info: PackageInfo): Long =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) info.longVersionCode else info.versionCode.toLong()

    // Its answer comes to InstallStatus: first that it needs you to confirm, with the screen that asks,
    // then whether it worked.
    private fun install(apk: File) {
        val installer = packageManager.packageInstaller
        val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL).apply {
            setAppPackageName(packageName)
            setSize(apk.length())
        }
        val id = installer.createSession(params)
        try {
            installer.openSession(id).use { session ->
                FileInputStream(apk).use { input ->
                    session.openWrite("uwumaps.apk", 0, apk.length()).use { output ->
                        input.copyTo(output, 64 * 1024)
                        session.fsync(output)
                    }
                }
                // Mutable, for the installer to add its answer to. Explicit, to InstallStatus only.
                val flags = PendingIntent.FLAG_UPDATE_CURRENT or
                    (if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) PendingIntent.FLAG_MUTABLE else 0)
                val status = PendingIntent.getBroadcast(this, id, Intent(this, InstallStatus::class.java), flags)
                session.commit(status.intentSender)
            }
        } catch (e: Exception) {
            installer.abandonSession(id)
            throw e
        } finally {
            // The session has its own copy now.
            apk.delete()
        }
    }

    fun report(event: Map<String, Any?>) {
        Handler(Looper.getMainLooper()).post { channel?.invokeMethod("installStatus", event) }
    }

    /**
     * The installer's answers. Not exported, so only the installer, through the PendingIntent above, can
     * send them: an exported one would start any screen another app handed it.
     */
    class InstallStatus : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            val status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)
            val activity = showing.get()
            when (status) {
                PackageInstaller.STATUS_PENDING_USER_ACTION -> {
                    @Suppress("DEPRECATION")
                    val confirm: Intent = intent.getParcelableExtra(Intent.EXTRA_INTENT) ?: return
                    // Started while the updater is still on screen, so Android lets it open.
                    confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    context.startActivity(confirm)
                    activity?.report(mapOf("status" to "pending"))
                }
                PackageInstaller.STATUS_SUCCESS -> activity?.report(mapOf("status" to "success"))
                PackageInstaller.STATUS_FAILURE_ABORTED -> {
                    Log.i(TAG, "Install aborted: " + intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE))
                    activity?.report(mapOf("status" to "aborted"))
                }
                else -> {
                    Log.w(TAG, "Install failed: $status " + intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE))
                    val why = when (status) {
                        PackageInstaller.STATUS_FAILURE_CONFLICT, PackageInstaller.STATUS_FAILURE_INCOMPATIBLE -> "conflict"
                        PackageInstaller.STATUS_FAILURE_STORAGE -> "storage"
                        else -> "failed"
                    }
                    activity?.report(mapOf("status" to why))
                }
            }
        }
    }

    companion object {
        private const val CHANNEL = "org.uwuapps.maps/device"
        private const val TAG = "uwuMapsUpdate"
        private var showing = WeakReference<MainActivity>(null)
    }
}
