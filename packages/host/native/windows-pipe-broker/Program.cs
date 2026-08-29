using System.Buffers;
using System.ComponentModel;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using Microsoft.Win32.SafeHandles;

namespace FoundryMcp.WindowsPipeBroker;

internal static class Program
{
    private const int ProtocolVersion = 1;
    private const int MaximumControlPayloadBytes = 16 * 1024 * 1024;
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        PropertyNameCaseInsensitive = true,
    };
    private static readonly SemaphoreSlim OutputLock = new(1, 1);

    public static async Task<int> Main(string[] args)
    {
        Console.InputEncoding = Encoding.UTF8;
        Console.OutputEncoding = new UTF8Encoding(encoderShouldEmitUTF8Identifier: false);

        try
        {
            if (!OperatingSystem.IsWindows())
            {
                throw new PlatformNotSupportedException("The Foundry MCP pipe broker only runs on Windows.");
            }

            ParsedArguments parsed = ParsedArguments.Parse(args);
            return parsed.Command switch
            {
                "serve" => await RunServerAsync(parsed).ConfigureAwait(false),
                "inspect" => await RunInspectionAsync(parsed).ConfigureAwait(false),
                _ => throw new ArgumentException("Expected 'serve' or 'inspect'."),
            };
        }
        catch (Exception exception)
        {
            await Console.Error.WriteLineAsync($"foundry-mcp-pipe-broker: {exception.Message}").ConfigureAwait(false);
            return 1;
        }
    }

    private static async Task<int> RunServerAsync(ParsedArguments arguments)
    {
        WindowsIdentitySnapshot daemonIdentity = WindowsIdentitySnapshot.GetCurrentProcessIdentity();
        using CancellationTokenSource shutdown = new();
        BrokerState state = new(shutdown);
        Task commandLoop = Task.Run(
            () => ProcessHostCommandsAsync(state, shutdown.Token),
            CancellationToken.None);
        bool announcedReady = false;
        long nextConnectionId = 0;

        try
        {
            while (!shutdown.IsCancellationRequested)
            {
                using SecurityDescriptorBuffer descriptor = SecurityDescriptorBuffer.Create(daemonIdentity);
                using NamedPipeServerStream pipe = WindowsPipeFactory.Create(arguments.PipePath, descriptor);
                DescriptorInspection inspection = PipeSecurityVerifier.Inspect(
                    pipe.SafePipeHandle,
                    daemonIdentity.UserSid,
                    daemonIdentity.LogonSid);

                if (!inspection.Verified)
                {
                    throw new InvalidOperationException($"Created pipe failed descriptor verification: {inspection.FailureReason}");
                }

                if (!announcedReady)
                {
                    await EmitAsync(new
                    {
                        type = "ready",
                        protocol = ProtocolVersion,
                        ownerSid = daemonIdentity.UserSid,
                        logonSid = daemonIdentity.LogonSid,
                        descriptorVerified = true,
                        remoteClientsRejected = true,
                        firstInstance = true,
                        descriptorSddl = inspection.Sddl,
                    }).ConfigureAwait(false);
                    announcedReady = true;
                }

                try
                {
                    await pipe.WaitForConnectionAsync(shutdown.Token).ConfigureAwait(false);
                }
                catch (OperationCanceledException) when (shutdown.IsCancellationRequested)
                {
                    break;
                }

                byte[] rented = ArrayPool<byte>.Shared.Rent(64 * 1024);
                string connectionId = Interlocked.Increment(ref nextConnectionId).ToString(System.Globalization.CultureInfo.InvariantCulture);
                try
                {
                    int firstRead = await pipe.ReadAsync(rented.AsMemory(0, rented.Length), shutdown.Token).ConfigureAwait(false);
                    if (firstRead == 0)
                    {
                        continue;
                    }

                    ClientTokenInspection client = ClientTokenVerifier.Inspect(pipe.SafePipeHandle, daemonIdentity);
                    if (!client.Verified)
                    {
                        await EmitAsync(new
                        {
                            type = "rejected",
                            connectionId,
                            reason = client.FailureReason,
                        }).ConfigureAwait(false);
                        continue;
                    }

                    PipeConnection connection = new(connectionId, pipe);
                    state.SetCurrent(connection);
                    await EmitAsync(new
                    {
                        type = "connected",
                        connectionId,
                        clientUserSid = client.UserSid,
                        clientLogonSid = client.LogonSid,
                        tokenVerified = true,
                    }).ConfigureAwait(false);
                    await EmitDataAsync(connectionId, rented.AsMemory(0, firstRead)).ConfigureAwait(false);

                    while (!shutdown.IsCancellationRequested && pipe.IsConnected)
                    {
                        int read = await pipe.ReadAsync(rented.AsMemory(0, rented.Length), shutdown.Token).ConfigureAwait(false);
                        if (read == 0)
                        {
                            break;
                        }
                        await EmitDataAsync(connectionId, rented.AsMemory(0, read)).ConfigureAwait(false);
                    }
                }
                catch (OperationCanceledException) when (shutdown.IsCancellationRequested)
                {
                    break;
                }
                catch (IOException exception)
                {
                    await Console.Error.WriteLineAsync($"pipe connection ended: {exception.Message}").ConfigureAwait(false);
                }
                finally
                {
                    state.ClearCurrent(connectionId);
                    ArrayPool<byte>.Shared.Return(rented, clearArray: true);
                    await EmitAsync(new { type = "disconnected", connectionId }).ConfigureAwait(false);
                }
            }
        }
        finally
        {
            shutdown.Cancel();
            state.CloseCurrent();
            try
            {
                await commandLoop.ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                // Normal shutdown.
            }
        }

        return 0;
    }

    private static async Task ProcessHostCommandsAsync(BrokerState state, CancellationToken cancellationToken)
    {
        try
        {
            while (!cancellationToken.IsCancellationRequested)
            {
                string? line = await Console.In.ReadLineAsync(cancellationToken).ConfigureAwait(false);
                if (line is null)
                {
                    state.RequestShutdown();
                    return;
                }
                if (Encoding.UTF8.GetByteCount(line) > MaximumControlPayloadBytes)
                {
                    throw new InvalidDataException("Host control message exceeds the maximum size.");
                }

                HostCommand? command = JsonSerializer.Deserialize<HostCommand>(line, JsonOptions);
                if (command is null || string.IsNullOrWhiteSpace(command.Type))
                {
                    throw new InvalidDataException("Invalid host control message.");
                }

                switch (command.Type)
                {
                    case "data":
                        if (string.IsNullOrEmpty(command.ConnectionId) || string.IsNullOrEmpty(command.Data))
                        {
                            throw new InvalidDataException("Data command is missing connectionId or data.");
                        }
                        byte[] payload = Convert.FromBase64String(command.Data);
                        if (payload.Length > MaximumControlPayloadBytes)
                        {
                            throw new InvalidDataException("Host data payload exceeds the maximum size.");
                        }
                        await state.WriteAsync(command.ConnectionId, payload, cancellationToken).ConfigureAwait(false);
                        break;
                    case "close":
                        if (!string.IsNullOrEmpty(command.ConnectionId))
                        {
                            state.Close(command.ConnectionId);
                        }
                        break;
                    case "shutdown":
                        state.RequestShutdown();
                        return;
                    default:
                        throw new InvalidDataException($"Unknown host control message type '{command.Type}'.");
                }
            }
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            // Normal shutdown.
        }
        catch (Exception exception)
        {
            await Console.Error.WriteLineAsync($"host control channel failed: {exception.Message}").ConfigureAwait(false);
            state.RequestShutdown();
        }
    }

    private static async Task<int> RunInspectionAsync(ParsedArguments arguments)
    {
        WindowsIdentitySnapshot identity = WindowsIdentitySnapshot.GetCurrentProcessIdentity();
        string expectedUserSid = arguments.ExpectedUserSid ?? identity.UserSid;
        string expectedLogonSid = arguments.ExpectedLogonSid ?? identity.LogonSid;

        using SafeFileHandle pipe = WindowsPipeFactory.OpenForInspection(arguments.PipePath, TimeSpan.FromSeconds(5));
        DescriptorInspection inspection = PipeSecurityVerifier.Inspect(pipe, expectedUserSid, expectedLogonSid);

        byte[] sentinel = [0];
        if (!NativeMethods.WriteFile(pipe, sentinel, (uint)sentinel.Length, out _, IntPtr.Zero))
        {
            throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not complete the descriptor probe.");
        }

        await EmitAsync(new
        {
            type = "inspection",
            protocol = ProtocolVersion,
            verified = inspection.Verified,
            ownerSid = inspection.OwnerSid,
            expectedUserSid,
            expectedLogonSid,
            descriptorSddl = inspection.Sddl,
            failureReason = inspection.FailureReason,
        }).ConfigureAwait(false);
        return inspection.Verified ? 0 : 4;
    }

    private static Task EmitDataAsync(string connectionId, ReadOnlyMemory<byte> payload)
    {
        return EmitAsync(new
        {
            type = "data",
            connectionId,
            data = Convert.ToBase64String(payload.Span),
        });
    }

    private static async Task EmitAsync(object value)
    {
        string line = JsonSerializer.Serialize(value, JsonOptions);
        await OutputLock.WaitAsync().ConfigureAwait(false);
        try
        {
            await Console.Out.WriteLineAsync(line).ConfigureAwait(false);
            await Console.Out.FlushAsync().ConfigureAwait(false);
        }
        finally
        {
            OutputLock.Release();
        }
    }

    private sealed record HostCommand(string? Type, string? ConnectionId, string? Data);
}

internal sealed class ParsedArguments
{
    private ParsedArguments(string command, string pipePath, string? expectedUserSid, string? expectedLogonSid)
    {
        Command = command;
        PipePath = pipePath;
        ExpectedUserSid = expectedUserSid;
        ExpectedLogonSid = expectedLogonSid;
    }

    public string Command { get; }
    public string PipePath { get; }
    public string? ExpectedUserSid { get; }
    public string? ExpectedLogonSid { get; }

    public static ParsedArguments Parse(string[] args)
    {
        if (args.Length < 3)
        {
            throw new ArgumentException("Usage: foundry-mcp-pipe-broker <serve|inspect> --pipe \\\\.\\pipe\\foundry-mcp-<id> [--expected-user-sid SID] [--expected-logon-sid SID]");
        }

        string command = args[0];
        string? pipePath = null;
        string? expectedUserSid = null;
        string? expectedLogonSid = null;
        for (int index = 1; index < args.Length; index += 2)
        {
            if (index + 1 >= args.Length)
            {
                throw new ArgumentException($"Missing value for '{args[index]}'.");
            }
            switch (args[index])
            {
                case "--pipe":
                    pipePath = args[index + 1];
                    break;
                case "--expected-user-sid":
                    expectedUserSid = args[index + 1];
                    break;
                case "--expected-logon-sid":
                    expectedLogonSid = args[index + 1];
                    break;
                default:
                    throw new ArgumentException($"Unknown argument '{args[index]}'.");
            }
        }

        if (string.IsNullOrWhiteSpace(pipePath) ||
            !pipePath.StartsWith(@"\\.\pipe\foundry-mcp-", StringComparison.OrdinalIgnoreCase))
        {
            throw new ArgumentException("Pipe path must be a local Foundry MCP path under \\\\.\\pipe\\foundry-mcp-.");
        }
        string suffix = pipePath[@"\\.\pipe\foundry-mcp-".Length..];
        if (suffix.Length is < 1 or > 160 || suffix.Any(character => !char.IsAsciiLetterOrDigit(character) && character is not '-' and not '_' and not '.'))
        {
            throw new ArgumentException("Pipe name contains unsupported characters.");
        }
        if (command is not "serve" and not "inspect")
        {
            throw new ArgumentException("Expected 'serve' or 'inspect'.");
        }

        return new ParsedArguments(command, pipePath, expectedUserSid, expectedLogonSid);
    }
}

internal sealed class BrokerState
{
    private readonly object gate = new();
    private readonly CancellationTokenSource shutdown;
    private PipeConnection? current;

    public BrokerState(CancellationTokenSource shutdown)
    {
        this.shutdown = shutdown;
    }

    public void SetCurrent(PipeConnection connection)
    {
        lock (gate)
        {
            current = connection;
        }
    }

    public void ClearCurrent(string connectionId)
    {
        lock (gate)
        {
            if (current?.ConnectionId == connectionId)
            {
                current = null;
            }
        }
    }

    public async Task WriteAsync(string connectionId, byte[] payload, CancellationToken cancellationToken)
    {
        PipeConnection? connection;
        lock (gate)
        {
            connection = current?.ConnectionId == connectionId ? current : null;
        }
        if (connection is null)
        {
            return;
        }
        await connection.WriteAsync(payload, cancellationToken).ConfigureAwait(false);
    }

    public void Close(string connectionId)
    {
        lock (gate)
        {
            if (current?.ConnectionId == connectionId)
            {
                current.Close();
            }
        }
    }

    public void CloseCurrent()
    {
        lock (gate)
        {
            current?.Close();
        }
    }

    public void RequestShutdown()
    {
        shutdown.Cancel();
        CloseCurrent();
    }
}

internal sealed class PipeConnection
{
    private readonly NamedPipeServerStream stream;
    private readonly SemaphoreSlim writeLock = new(1, 1);

    public PipeConnection(string connectionId, NamedPipeServerStream stream)
    {
        ConnectionId = connectionId;
        this.stream = stream;
    }

    public string ConnectionId { get; }

    public async Task WriteAsync(byte[] payload, CancellationToken cancellationToken)
    {
        await writeLock.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            if (!stream.IsConnected)
            {
                return;
            }
            await stream.WriteAsync(payload, cancellationToken).ConfigureAwait(false);
            await stream.FlushAsync(cancellationToken).ConfigureAwait(false);
        }
        finally
        {
            writeLock.Release();
        }
    }

    public void Close()
    {
        stream.Dispose();
    }
}

internal sealed class SecurityDescriptorBuffer : IDisposable
{
    private SecurityDescriptorBuffer(IntPtr pointer)
    {
        Pointer = pointer;
    }

    public IntPtr Pointer { get; }

    public static SecurityDescriptorBuffer Create(WindowsIdentitySnapshot identity)
    {
        string sddl = $"O:{identity.UserSid}G:{identity.UserSid}D:P(A;;GA;;;{identity.LogonSid})";
        if (!NativeMethods.ConvertStringSecurityDescriptorToSecurityDescriptor(
                sddl,
                NativeMethods.SddlRevision1,
                out IntPtr descriptor,
                out _))
        {
            throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not construct the pipe security descriptor.");
        }
        return new SecurityDescriptorBuffer(descriptor);
    }

    public void Dispose()
    {
        if (Pointer != IntPtr.Zero)
        {
            NativeMethods.LocalFree(Pointer);
        }
    }
}

internal static class WindowsPipeFactory
{
    public static NamedPipeServerStream Create(string pipePath, SecurityDescriptorBuffer descriptor)
    {
        NativeMethods.SecurityAttributes attributes = new()
        {
            Length = Marshal.SizeOf<NativeMethods.SecurityAttributes>(),
            SecurityDescriptor = descriptor.Pointer,
            InheritHandle = false,
        };

        SafePipeHandle handle = NativeMethods.CreateNamedPipe(
            pipePath,
            NativeMethods.PipeAccessDuplex | NativeMethods.FileFlagOverlapped | NativeMethods.FileFlagFirstPipeInstance,
            NativeMethods.PipeTypeByte | NativeMethods.PipeReadModeByte | NativeMethods.PipeWait | NativeMethods.PipeRejectRemoteClients,
            1,
            64 * 1024,
            64 * 1024,
            0,
            ref attributes);
        if (handle.IsInvalid)
        {
            int error = Marshal.GetLastWin32Error();
            handle.Dispose();
            throw new Win32Exception(error, "Could not create the protected named pipe (the name may already be owned).");
        }

        try
        {
            return new NamedPipeServerStream(PipeDirection.InOut, isAsync: true, isConnected: false, handle);
        }
        catch
        {
            handle.Dispose();
            throw;
        }
    }

    public static SafeFileHandle OpenForInspection(string pipePath, TimeSpan timeout)
    {
        DateTime deadline = DateTime.UtcNow + timeout;
        while (true)
        {
            SafeFileHandle handle = NativeMethods.CreateFile(
                pipePath,
                NativeMethods.GenericRead | NativeMethods.GenericWrite | NativeMethods.ReadControl,
                0,
                IntPtr.Zero,
                NativeMethods.OpenExisting,
                0,
                IntPtr.Zero);
            if (!handle.IsInvalid)
            {
                return handle;
            }

            int error = Marshal.GetLastWin32Error();
            handle.Dispose();
            if (DateTime.UtcNow >= deadline || (error != NativeMethods.ErrorPipeBusy && error != NativeMethods.ErrorFileNotFound))
            {
                throw new Win32Exception(error, "Could not open the named pipe for descriptor inspection.");
            }
            NativeMethods.WaitNamedPipe(pipePath, 100);
        }
    }
}

internal sealed record WindowsIdentitySnapshot(string UserSid, string LogonSid)
{
    public static WindowsIdentitySnapshot GetCurrentProcessIdentity()
    {
        if (!NativeMethods.OpenProcessToken(NativeMethods.GetCurrentProcess(), NativeMethods.TokenQuery, out SafeTokenHandle token))
        {
            throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not open the daemon process token.");
        }
        using (token)
        {
            return TokenReader.ReadIdentity(token);
        }
    }
}

internal static class ClientTokenVerifier
{
    public static ClientTokenInspection Inspect(SafePipeHandle pipe, WindowsIdentitySnapshot expected)
    {
        if (!NativeMethods.ImpersonateNamedPipeClient(pipe.DangerousGetHandle()))
        {
            return new ClientTokenInspection(false, null, null, "ImpersonateNamedPipeClient failed.");
        }

        try
        {
            if (!NativeMethods.OpenThreadToken(NativeMethods.GetCurrentThread(), NativeMethods.TokenQuery, true, out SafeTokenHandle token))
            {
                return new ClientTokenInspection(false, null, null, "OpenThreadToken failed.");
            }
            using (token)
            {
                WindowsIdentitySnapshot client = TokenReader.ReadIdentity(token);
                bool verified = string.Equals(client.UserSid, expected.UserSid, StringComparison.OrdinalIgnoreCase) &&
                                string.Equals(client.LogonSid, expected.LogonSid, StringComparison.OrdinalIgnoreCase);
                return new ClientTokenInspection(
                    verified,
                    client.UserSid,
                    client.LogonSid,
                    verified ? null : "Client TokenUser or logon SID does not match the daemon.");
            }
        }
        finally
        {
            if (!NativeMethods.RevertToSelf())
            {
                Environment.FailFast("RevertToSelf failed after named-pipe client impersonation.");
            }
        }
    }
}

internal sealed record ClientTokenInspection(bool Verified, string? UserSid, string? LogonSid, string? FailureReason);

internal static class TokenReader
{
    public static WindowsIdentitySnapshot ReadIdentity(SafeTokenHandle token)
    {
        using TokenInformationBuffer user = TokenInformationBuffer.Read(token, NativeMethods.TokenInformationClass.TokenUser);
        NativeMethods.SidAndAttributes tokenUser = Marshal.PtrToStructure<NativeMethods.SidAndAttributes>(user.Pointer);
        string userSid = Sid.ToString(tokenUser.Sid);

        using TokenInformationBuffer groups = TokenInformationBuffer.Read(token, NativeMethods.TokenInformationClass.TokenGroups);
        int groupCount = Marshal.ReadInt32(groups.Pointer);
        int firstGroupOffset = IntPtr.Size == 8 ? 8 : 4;
        int groupSize = Marshal.SizeOf<NativeMethods.SidAndAttributes>();
        string? logonSid = null;
        for (int index = 0; index < groupCount; index++)
        {
            IntPtr groupPointer = IntPtr.Add(groups.Pointer, firstGroupOffset + (index * groupSize));
            NativeMethods.SidAndAttributes group = Marshal.PtrToStructure<NativeMethods.SidAndAttributes>(groupPointer);
            if ((group.Attributes & NativeMethods.SeGroupLogonId) == NativeMethods.SeGroupLogonId)
            {
                logonSid = Sid.ToString(group.Sid);
                break;
            }
        }

        if (logonSid is null)
        {
            throw new InvalidOperationException("The access token does not contain a logon SID.");
        }
        return new WindowsIdentitySnapshot(userSid, logonSid);
    }
}

internal sealed class TokenInformationBuffer : IDisposable
{
    private TokenInformationBuffer(IntPtr pointer)
    {
        Pointer = pointer;
    }

    public IntPtr Pointer { get; }

    public static TokenInformationBuffer Read(SafeTokenHandle token, NativeMethods.TokenInformationClass informationClass)
    {
        NativeMethods.GetTokenInformation(token, informationClass, IntPtr.Zero, 0, out uint required);
        int firstError = Marshal.GetLastWin32Error();
        if (required == 0 || firstError != NativeMethods.ErrorInsufficientBuffer)
        {
            throw new Win32Exception(firstError, $"Could not size token information '{informationClass}'.");
        }

        IntPtr buffer = Marshal.AllocHGlobal(checked((int)required));
        if (!NativeMethods.GetTokenInformation(token, informationClass, buffer, required, out _))
        {
            int error = Marshal.GetLastWin32Error();
            Marshal.FreeHGlobal(buffer);
            throw new Win32Exception(error, $"Could not read token information '{informationClass}'.");
        }
        return new TokenInformationBuffer(buffer);
    }

    public void Dispose()
    {
        Marshal.FreeHGlobal(Pointer);
    }
}

internal static class Sid
{
    public static string ToString(IntPtr sid)
    {
        if (sid == IntPtr.Zero || !NativeMethods.IsValidSid(sid))
        {
            throw new InvalidOperationException("Windows returned an invalid SID.");
        }
        if (!NativeMethods.ConvertSidToStringSid(sid, out IntPtr sidString))
        {
            throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not convert a SID to text.");
        }
        try
        {
            return Marshal.PtrToStringUni(sidString) ?? throw new InvalidOperationException("Windows returned an empty SID.");
        }
        finally
        {
            NativeMethods.LocalFree(sidString);
        }
    }
}

internal static class PipeSecurityVerifier
{
    public static DescriptorInspection Inspect(SafeHandle handle, string expectedOwnerSid, string expectedLogonSid)
    {
        uint result = NativeMethods.GetSecurityInfo(
            handle.DangerousGetHandle(),
            NativeMethods.SeObjectType.SeKernelObject,
            NativeMethods.OwnerSecurityInformation | NativeMethods.DaclSecurityInformation,
            out IntPtr owner,
            out _,
            out IntPtr dacl,
            out _,
            out IntPtr descriptor);
        if (result != 0)
        {
            return new DescriptorInspection(false, null, null, $"GetSecurityInfo failed with Win32 error {result}.");
        }

        try
        {
            string ownerSid = Sid.ToString(owner);
            string? sddl = ToSddl(descriptor);
            if (!string.Equals(ownerSid, expectedOwnerSid, StringComparison.OrdinalIgnoreCase))
            {
                return new DescriptorInspection(false, ownerSid, sddl, "Pipe owner SID does not match the current user.");
            }
            if (dacl == IntPtr.Zero)
            {
                return new DescriptorInspection(false, ownerSid, sddl, "Pipe has a null DACL.");
            }
            if (!NativeMethods.GetSecurityDescriptorControl(descriptor, out ushort control, out _))
            {
                return new DescriptorInspection(false, ownerSid, sddl, "Could not read security descriptor control flags.");
            }
            if ((control & NativeMethods.SeDaclPresent) == 0 || (control & NativeMethods.SeDaclProtected) == 0)
            {
                return new DescriptorInspection(false, ownerSid, sddl, "Pipe DACL is missing or inherits access entries.");
            }

            NativeMethods.AclSizeInformation aclInfo = default;
            if (!NativeMethods.GetAclInformation(
                    dacl,
                    ref aclInfo,
                    (uint)Marshal.SizeOf<NativeMethods.AclSizeInformation>(),
                    NativeMethods.AclInformationClass.AclSizeInformation))
            {
                return new DescriptorInspection(false, ownerSid, sddl, "Could not inspect the pipe DACL.");
            }
            if (aclInfo.AceCount != 1 || !NativeMethods.GetAce(dacl, 0, out IntPtr ace))
            {
                return new DescriptorInspection(false, ownerSid, sddl, "Pipe DACL must contain exactly one access entry.");
            }

            NativeMethods.AceHeader header = Marshal.PtrToStructure<NativeMethods.AceHeader>(ace);
            if (header.AceType != NativeMethods.AccessAllowedAceType || header.AceFlags != 0 || header.AceSize < 12)
            {
                return new DescriptorInspection(false, ownerSid, sddl, "Pipe DACL contains an unexpected access entry.");
            }
            uint mask = unchecked((uint)Marshal.ReadInt32(ace, 4));
            if ((mask & NativeMethods.GenericAll) == 0 && (mask & NativeMethods.FileAllAccess) != NativeMethods.FileAllAccess)
            {
                return new DescriptorInspection(false, ownerSid, sddl, "Current logon SID does not have full pipe access.");
            }
            string aceSid = Sid.ToString(IntPtr.Add(ace, 8));
            if (!string.Equals(aceSid, expectedLogonSid, StringComparison.OrdinalIgnoreCase))
            {
                return new DescriptorInspection(false, ownerSid, sddl, "Pipe DACL is not restricted to the expected logon SID.");
            }

            return new DescriptorInspection(true, ownerSid, sddl, null);
        }
        finally
        {
            NativeMethods.LocalFree(descriptor);
        }
    }

    private static string? ToSddl(IntPtr descriptor)
    {
        if (!NativeMethods.ConvertSecurityDescriptorToStringSecurityDescriptor(
                descriptor,
                NativeMethods.SddlRevision1,
                NativeMethods.OwnerSecurityInformation | NativeMethods.DaclSecurityInformation,
                out IntPtr sddl,
                out _))
        {
            return null;
        }
        try
        {
            return Marshal.PtrToStringUni(sddl);
        }
        finally
        {
            NativeMethods.LocalFree(sddl);
        }
    }
}

internal sealed record DescriptorInspection(bool Verified, string? OwnerSid, string? Sddl, string? FailureReason);

internal sealed class SafeTokenHandle : SafeHandleZeroOrMinusOneIsInvalid
{
    private SafeTokenHandle() : base(ownsHandle: true)
    {
    }

    protected override bool ReleaseHandle()
    {
        return NativeMethods.CloseHandle(handle);
    }
}

internal static class NativeMethods
{
    internal const uint SddlRevision1 = 1;
    internal const uint TokenQuery = 0x0008;
    internal const uint SeGroupLogonId = 0xC0000000;
    internal const int ErrorInsufficientBuffer = 122;
    internal const int ErrorFileNotFound = 2;
    internal const int ErrorPipeBusy = 231;

    internal const uint PipeAccessDuplex = 0x00000003;
    internal const uint FileFlagOverlapped = 0x40000000;
    internal const uint FileFlagFirstPipeInstance = 0x00080000;
    internal const uint PipeTypeByte = 0x00000000;
    internal const uint PipeReadModeByte = 0x00000000;
    internal const uint PipeWait = 0x00000000;
    internal const uint PipeRejectRemoteClients = 0x00000008;

    internal const uint GenericRead = 0x80000000;
    internal const uint GenericWrite = 0x40000000;
    internal const uint GenericAll = 0x10000000;
    internal const uint ReadControl = 0x00020000;
    internal const uint FileAllAccess = 0x001F01FF;
    internal const uint OpenExisting = 3;

    internal const uint OwnerSecurityInformation = 0x00000001;
    internal const uint DaclSecurityInformation = 0x00000004;
    internal const ushort SeDaclPresent = 0x0004;
    internal const ushort SeDaclProtected = 0x1000;
    internal const byte AccessAllowedAceType = 0;

    internal enum TokenInformationClass
    {
        TokenUser = 1,
        TokenGroups = 2,
    }

    internal enum SeObjectType
    {
        SeKernelObject = 6,
    }

    internal enum AclInformationClass
    {
        AclRevisionInformation = 1,
        AclSizeInformation = 2,
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct SecurityAttributes
    {
        internal int Length;
        internal IntPtr SecurityDescriptor;
        [MarshalAs(UnmanagedType.Bool)]
        internal bool InheritHandle;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct SidAndAttributes
    {
        internal IntPtr Sid;
        internal uint Attributes;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct AclSizeInformation
    {
        internal uint AceCount;
        internal uint AclBytesInUse;
        internal uint AclBytesFree;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct AceHeader
    {
        internal byte AceType;
        internal byte AceFlags;
        internal ushort AceSize;
    }

    [DllImport("kernel32.dll", EntryPoint = "GetCurrentProcess")]
    internal static extern IntPtr GetCurrentProcess();

    [DllImport("kernel32.dll", EntryPoint = "GetCurrentThread")]
    internal static extern IntPtr GetCurrentThread();

    [DllImport("kernel32.dll", EntryPoint = "CloseHandle", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool CloseHandle(IntPtr handle);

    [DllImport("advapi32.dll", EntryPoint = "OpenProcessToken", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool OpenProcessToken(IntPtr processHandle, uint desiredAccess, out SafeTokenHandle tokenHandle);

    [DllImport("advapi32.dll", EntryPoint = "OpenThreadToken", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool OpenThreadToken(
        IntPtr threadHandle,
        uint desiredAccess,
        [MarshalAs(UnmanagedType.Bool)] bool openAsSelf,
        out SafeTokenHandle tokenHandle);

    [DllImport("advapi32.dll", EntryPoint = "GetTokenInformation", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool GetTokenInformation(
        SafeTokenHandle tokenHandle,
        TokenInformationClass tokenInformationClass,
        IntPtr tokenInformation,
        uint tokenInformationLength,
        out uint returnLength);

    [DllImport("advapi32.dll", EntryPoint = "ConvertStringSecurityDescriptorToSecurityDescriptorW", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool ConvertStringSecurityDescriptorToSecurityDescriptor(
        string stringSecurityDescriptor,
        uint stringSdRevision,
        out IntPtr securityDescriptor,
        out uint securityDescriptorSize);

    [DllImport("advapi32.dll", EntryPoint = "ConvertSecurityDescriptorToStringSecurityDescriptorW", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool ConvertSecurityDescriptorToStringSecurityDescriptor(
        IntPtr securityDescriptor,
        uint requestedStringSdRevision,
        uint securityInformation,
        out IntPtr stringSecurityDescriptor,
        out uint stringSecurityDescriptorLength);

    [DllImport("advapi32.dll", EntryPoint = "ConvertSidToStringSidW", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool ConvertSidToStringSid(IntPtr sid, out IntPtr stringSid);

    [DllImport("advapi32.dll", EntryPoint = "IsValidSid", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool IsValidSid(IntPtr sid);

    [DllImport("advapi32.dll", EntryPoint = "ImpersonateNamedPipeClient", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool ImpersonateNamedPipeClient(IntPtr namedPipeHandle);

    [DllImport("advapi32.dll", EntryPoint = "RevertToSelf", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool RevertToSelf();

    [DllImport("advapi32.dll", EntryPoint = "GetSecurityInfo")]
    internal static extern uint GetSecurityInfo(
        IntPtr handle,
        SeObjectType objectType,
        uint securityInfo,
        out IntPtr owner,
        out IntPtr group,
        out IntPtr dacl,
        out IntPtr sacl,
        out IntPtr securityDescriptor);

    [DllImport("advapi32.dll", EntryPoint = "GetSecurityDescriptorControl", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool GetSecurityDescriptorControl(
        IntPtr securityDescriptor,
        out ushort control,
        out uint revision);

    [DllImport("advapi32.dll", EntryPoint = "GetAclInformation", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool GetAclInformation(
        IntPtr acl,
        ref AclSizeInformation aclInformation,
        uint aclInformationLength,
        AclInformationClass aclInformationClass);

    [DllImport("advapi32.dll", EntryPoint = "GetAce", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool GetAce(IntPtr acl, uint aceIndex, out IntPtr ace);

    [DllImport("kernel32.dll", EntryPoint = "CreateNamedPipeW", CharSet = CharSet.Unicode, SetLastError = true)]
    internal static extern SafePipeHandle CreateNamedPipe(
        string name,
        uint openMode,
        uint pipeMode,
        uint maxInstances,
        uint outBufferSize,
        uint inBufferSize,
        uint defaultTimeout,
        ref SecurityAttributes securityAttributes);

    [DllImport("kernel32.dll", EntryPoint = "CreateFileW", CharSet = CharSet.Unicode, SetLastError = true)]
    internal static extern SafeFileHandle CreateFile(
        string fileName,
        uint desiredAccess,
        uint shareMode,
        IntPtr securityAttributes,
        uint creationDisposition,
        uint flagsAndAttributes,
        IntPtr templateFile);

    [DllImport("kernel32.dll", EntryPoint = "WaitNamedPipeW", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool WaitNamedPipe(string name, uint timeout);

    [DllImport("kernel32.dll", EntryPoint = "WriteFile", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool WriteFile(
        SafeFileHandle file,
        byte[] buffer,
        uint numberOfBytesToWrite,
        out uint numberOfBytesWritten,
        IntPtr overlapped);

    [DllImport("kernel32.dll", EntryPoint = "LocalFree")]
    internal static extern IntPtr LocalFree(IntPtr memory);
}
