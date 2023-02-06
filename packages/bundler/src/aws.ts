import { SSM } from "aws-sdk"

const getParamValue = async (
    ssm: SSM,
    name: string,
    decrypt: boolean = true
): Promise<string> => {
    const params: SSM.GetParameterRequest = {
        Name: name,
        WithDecryption: decrypt,
    };

    const res = await ssm.getParameter(params).promise();
    return res.Parameter?.Value!;
};


export const getSSMParameter = async (name: string, region: string = 'us-west-2'): Promise<string> => {
    const config: SSM.Types.ClientConfiguration = { region: region }
    const ssm = new SSM(config);
    return getParamValue(ssm, name, false);
}