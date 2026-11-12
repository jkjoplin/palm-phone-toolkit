import javax.inject.Inject

plugins {
    id("com.android.application")
}

android {
    namespace = "com.palmmoods.shell"
    compileSdk = 37

    defaultConfig {
        applicationId = "com.palmmoods.shell"
        minSdk = 27
        targetSdk = 37
        versionCode = 2
        versionName = "0.2.0"
    }

    buildFeatures {
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    androidResources {
        // The default pattern also drops directories whose names start with "_".
        // Keep those, so the UI can name folders freely. Dotfiles are still skipped.
        ignoreAssetsPattern = "!.svn:!.git:!.ds_store:!*.scc:.*:!CVS:!thumbs.db:!picasa.ini:!*~"
    }
}

dependencies {
    // android.jar's org.json is a stub in JVM tests; use the real one there.
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20250517")
}

// ShellConfigTest also runs the config cases shared with tools/check_config.py.
val configCases = rootProject.layout.projectDirectory.file("../tools/config-cases.json")
tasks.withType<Test>().configureEach {
    inputs.file(configCases).withPathSensitivity(PathSensitivity.NONE)
    systemProperty("configCases", configCases.asFile.absolutePath)
}

/**
 * Copies the repo's ui/ folder to <generated>/ui so the page lands at
 * file:///android_asset/ui/index.html. The UI has no build step of its own.
 * ui/dev/ (the fake Home Assistant, test tools and their screenshots) is never
 * loaded by the page, so it is left out of the APK, and is not even an input:
 * new screenshots there do not re-run this task.
 */
abstract class CopyUiAssets : DefaultTask() {
    @get:Internal
    abstract val uiDir: DirectoryProperty

    @get:InputFiles
    @get:PathSensitive(PathSensitivity.RELATIVE)
    val uiFiles: FileTree
        get() = uiDir.asFileTree.matching { exclude(EXCLUDES) }

    @get:OutputDirectory
    abstract val outputDir: DirectoryProperty

    @get:Inject
    abstract val fs: FileSystemOperations

    @TaskAction
    fun copy() {
        // sync, not copy: anything no longer in the filtered tree (an old dev/) is deleted
        fs.sync {
            from(uiFiles)
            into(outputDir.dir("ui"))
        }
    }

    companion object {
        val EXCLUDES = listOf("dev", "dev/**", "**/.DS_Store")
    }
}

val copyUiAssets = tasks.register<CopyUiAssets>("copyUiAssets") {
    uiDir.set(rootProject.layout.projectDirectory.dir("../ui"))
}

androidComponents {
    onVariants { variant ->
        variant.sources.assets?.addGeneratedSourceDirectory(copyUiAssets, CopyUiAssets::outputDir)
    }
}
